/* =============================================================================
   renderer.js — virtualized, memory-capped PDF page rendering.

   Core rules this file exists to enforce:
     - Only pages actually visible (±1 buffer) ever have a rendered <canvas>.
       Pages that scroll far off-screen get their canvas torn down entirely
       (width/height set to 0, then removed) rather than just hidden, since a
       hidden canvas still holds its full backing store in memory.
     - Render scale is capped, not "full native resolution" — retina-sharp
       (devicePixelRatio, capped at 2) is plenty; going higher just spends
       memory nobody can see. Total canvas area is additionally capped, since
       WebKit/Orion crashes well before Chrome does on large canvases.
     - Page wrapper divs are sized from each page's intrinsic dimensions
       *before* anything renders, so the scroll container never jumps as
       pages mount/unmount.

   Exposes createPdfRenderer({ pdfDoc, container, onPageRendered }).
   ============================================================================= */

const MAX_CANVAS_AREA = 16_000_000; // px^2 safety ceiling, most conservative on WebKit
const RENDER_SCALE_CAP = 2;
const BUFFER_PAGES = 1;

async function createPdfRenderer({ pdfDoc, container, onPageRendered, onPageUnmounted }){
  const numPages = pdfDoc.numPages;
  const pageWrappers = new Array(numPages + 1); // 1-indexed
  const pageState = new Array(numPages + 1).fill('unmounted'); // unmounted | mounted | rendering
  const baseViewports = new Array(numPages + 1);

  // Measure every page's intrinsic size up front — cheap (no rasterization),
  // needed so wrapper divs can be sized before their canvas exists.
  for(let i = 1; i <= numPages; i++){
    const page = await pdfDoc.getPage(i);
    baseViewports[i] = page.getViewport({ scale: 1 });
  }

  container.innerHTML = '';
  const containerWidth = () => container.clientWidth;

  for(let i = 1; i <= numPages; i++){
    const vp = baseViewports[i];
    const cssScale = containerWidth() / vp.width;
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrap';
    wrapper.dataset.page = String(i);
    wrapper.style.position = 'relative';
    wrapper.style.width = '100%';
    wrapper.style.aspectRatio = `${vp.width} / ${vp.height}`;
    wrapper.style.marginBottom = '10px';
    wrapper.style.background = 'var(--surface)';
    wrapper.style.border = '1px solid var(--border)';
    container.appendChild(wrapper);
    pageWrappers[i] = wrapper;
  }

  async function mountPage(pageNumber){
    if(pageState[pageNumber] !== 'unmounted') return;
    pageState[pageNumber] = 'rendering';
    const wrapper = pageWrappers[pageNumber];
    const page = await pdfDoc.getPage(pageNumber);
    const baseVp = baseViewports[pageNumber];

    const cssWidth = wrapper.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, RENDER_SCALE_CAP);
    let scale = (cssWidth / baseVp.width) * dpr;

    // clamp total canvas area for WebKit/Orion safety
    const projectedArea = (baseVp.width * scale) * (baseVp.height * scale);
    if(projectedArea > MAX_CANVAS_AREA){
      scale *= Math.sqrt(MAX_CANVAS_AREA / projectedArea);
    }

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    wrapper.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    if(pageState[pageNumber] === 'rendering'){
      pageState[pageNumber] = 'mounted';
      if(onPageRendered) onPageRendered(pageNumber, wrapper, canvas);
    }
  }

  function unmountPage(pageNumber){
    if(pageState[pageNumber] !== 'mounted') return;
    const wrapper = pageWrappers[pageNumber];
    const canvas = wrapper.querySelector('canvas');
    if(canvas){
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    pageState[pageNumber] = 'unmounted';
    if(onPageUnmounted) onPageUnmounted(pageNumber, wrapper);
  }

  let currentVisiblePage = 1;
  const observer = new IntersectionObserver((entries) => {
    for(const entry of entries){
      const pageNumber = Number(entry.target.dataset.page);
      if(entry.isIntersecting){
        for(let p = Math.max(1, pageNumber - BUFFER_PAGES); p <= Math.min(numPages, pageNumber + BUFFER_PAGES); p++){
          mountPage(p);
        }
        if(entry.intersectionRatio > 0.5) currentVisiblePage = pageNumber;
      } else {
        // only unmount once well clear of the buffer zone to avoid thrash
        const far = Math.abs(pageNumber - currentVisiblePage) > BUFFER_PAGES + 1;
        if(far) unmountPage(pageNumber);
      }
    }
  }, { root: container, rootMargin: '200px 0px', threshold: [0, 0.5] });

  for(let i = 1; i <= numPages; i++) observer.observe(pageWrappers[i]);

  return {
    scrollToPage(pageNumber){
      const wrapper = pageWrappers[pageNumber];
      if(wrapper) wrapper.scrollIntoView({ block: 'start' });
    },
    getCurrentPage(){ return currentVisiblePage; },
    getPageWrapper(pageNumber){ return pageWrappers[pageNumber]; },
    getNumPages(){ return numPages; },
    destroy(){
      observer.disconnect();
      for(let i = 1; i <= numPages; i++) unmountPage(i);
    },
  };
}
