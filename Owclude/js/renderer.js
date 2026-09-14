/* =============================================================================
   renderer.js — virtualized, memory-capped PDF page rendering.

   Fixes over the first version:
     1. No upfront getPage() loop. Measuring every page at load forced pdf.js
        to parse the whole document before a single page rendered — the exact
        thing that stalls big PDFs. Now we measure page 1 only, size every
        wrapper from that aspect ratio as a provisional guess, and correct
        each wrapper's real aspect ratio lazily the first time it mounts.
     2. Render cancellation. Each page keeps its RenderTask; scrolling fast no
        longer stacks overlapping render() calls on the same canvas (which
        pdf.js rejects, blanking the page). Re-mounting cancels the in-flight
        task first.
     3. A short settle debounce so flick-scrolling doesn't rasterize pages
        that were never actually looked at.

   Core memory rules unchanged: only visible (+/-1) pages hold a canvas;
   off-screen canvases are torn down (w/h = 0, removed); render scale and
   total canvas area are capped for WebKit/Orion safety.
   ============================================================================= */

const MAX_CANVAS_AREA = 16000000; // px^2 ceiling, most conservative on WebKit
const RENDER_SCALE_CAP = 2;
const BUFFER_PAGES = 1;
const MOUNT_SETTLE_MS = 90;

async function createPdfRenderer({ pdfDoc, container, onPageRendered, onPageUnmounted }){
  const numPages = pdfDoc.numPages;
  const pageWrappers = new Array(numPages + 1);               // 1-indexed
  const pageState = new Array(numPages + 1).fill('unmounted'); // unmounted | rendering | mounted
  const renderTasks = new Array(numPages + 1).fill(null);
  const measured = new Array(numPages + 1).fill(false);
  const mountTimers = new Array(numPages + 1).fill(null);

  // Measure page 1 only. Its aspect ratio is a good provisional size for all
  // wrappers (textbook pages are near-uniform); each wrapper is corrected on
  // its first real mount if it differs.
  const firstPage = await pdfDoc.getPage(1);
  const firstVp = firstPage.getViewport({ scale: 1 });
  const provisionalRatio = firstVp.width + ' / ' + firstVp.height;

  container.innerHTML = '';

  for(let i = 1; i <= numPages; i++){
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrap';
    wrapper.dataset.page = String(i);
    wrapper.style.position = 'relative';
    wrapper.style.width = '100%';
    wrapper.style.aspectRatio = provisionalRatio;
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

    let page;
    try {
      page = await pdfDoc.getPage(pageNumber);
    } catch {
      pageState[pageNumber] = 'unmounted';
      return;
    }

    // if this page got scheduled for unmount while getPage awaited, bail
    if(pageState[pageNumber] !== 'rendering') return;

    const baseVp = page.getViewport({ scale: 1 });

    // correct the wrapper's aspect ratio the first time we truly measure it
    if(!measured[pageNumber]){
      wrapper.style.aspectRatio = baseVp.width + ' / ' + baseVp.height;
      measured[pageNumber] = true;
    }

    const cssWidth = wrapper.clientWidth || firstVp.width;
    const dpr = Math.min(window.devicePixelRatio || 1, RENDER_SCALE_CAP);
    let scale = (cssWidth / baseVp.width) * dpr;

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
    const task = page.render({ canvasContext: ctx, viewport });
    renderTasks[pageNumber] = task;

    try {
      await task.promise;
    } catch(e){
      // RenderingCancelledException is expected when we cancel mid-scroll
      canvas.width = 0; canvas.height = 0; canvas.remove();
      renderTasks[pageNumber] = null;
      if(pageState[pageNumber] === 'rendering') pageState[pageNumber] = 'unmounted';
      return;
    }

    renderTasks[pageNumber] = null;
    if(pageState[pageNumber] === 'rendering'){
      pageState[pageNumber] = 'mounted';
      if(onPageRendered) onPageRendered(pageNumber, wrapper, canvas);
    }
  }

  function unmountPage(pageNumber){
    if(mountTimers[pageNumber]){ clearTimeout(mountTimers[pageNumber]); mountTimers[pageNumber] = null; }
    // cancel an in-flight render so it doesn't resolve onto a torn-down canvas
    if(renderTasks[pageNumber]){
      try { renderTasks[pageNumber].cancel(); } catch {}
      renderTasks[pageNumber] = null;
    }
    if(pageState[pageNumber] !== 'mounted' && pageState[pageNumber] !== 'rendering') return;
    const wrapper = pageWrappers[pageNumber];
    const canvas = wrapper.querySelector('canvas');
    if(canvas){ canvas.width = 0; canvas.height = 0; canvas.remove(); }
    pageState[pageNumber] = 'unmounted';
    if(onPageUnmounted) onPageUnmounted(pageNumber, wrapper);
  }

  function scheduleMount(pageNumber){
    if(pageState[pageNumber] !== 'unmounted') return;
    if(mountTimers[pageNumber]) return;
    mountTimers[pageNumber] = setTimeout(() => {
      mountTimers[pageNumber] = null;
      mountPage(pageNumber);
    }, MOUNT_SETTLE_MS);
  }

  let currentVisiblePage = 1;
  const observer = new IntersectionObserver((entries) => {
    for(const entry of entries){
      const pageNumber = Number(entry.target.dataset.page);
      if(entry.isIntersecting){
        for(let p = Math.max(1, pageNumber - BUFFER_PAGES); p <= Math.min(numPages, pageNumber + BUFFER_PAGES); p++){
          scheduleMount(p);
        }
        if(entry.intersectionRatio > 0.5) currentVisiblePage = pageNumber;
      } else {
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
