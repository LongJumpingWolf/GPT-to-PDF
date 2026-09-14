/* =============================================================================
   occlusion.js — the occlusion overlay layer.

   Occlusions are NEVER baked into the canvas bitmap. They're plain
   absolutely-positioned <div>s in a wrapper the same size as the page
   canvas, using normalized (0–1) coordinates so they survive zoom/rerender
   without any recalculation. This is what makes "occlusions of any size"
   and instant reveal/hide free — no re-render of the PDF page involved.

   Two interaction modes:
     'view' — click an occlusion to reveal/hide it (study mode)
     'add'  — pointer-drag on empty page area draws a new occlusion
   ============================================================================= */

function createOcclusionLayer({ onCreate, onSelect }){
  let mode = 'view';
  let blanketStyle = 'solid'; // 'solid' | 'transparent'
  const occlusionsByPage = new Map(); // pageNumber -> occlusion[]
  const layerByPage = new Map();      // pageNumber -> overlay <div>

  function setMode(m){ mode = m; }
  function getMode(){ return mode; }

  function setBlanketStyle(style){
    blanketStyle = style;
    for(const layer of layerByPage.values()){
      layer.querySelectorAll('.occ-box').forEach(el => applyBlanketStyle(el));
    }
  }

  function applyBlanketStyle(el){
    if(blanketStyle === 'transparent'){
      el.style.background = 'rgba(27,39,51,0.35)';
    } else {
      el.style.background = 'var(--text)';
    }
  }

  function setOcclusionsForPage(pageNumber, occlusions){
    occlusionsByPage.set(pageNumber, occlusions);
    const layer = layerByPage.get(pageNumber);
    if(layer) renderOcclusions(pageNumber, layer);
  }

  function renderOcclusions(pageNumber, layer){
    layer.querySelectorAll('.occ-box').forEach(el => el.remove());
    const list = occlusionsByPage.get(pageNumber) || [];
    for(const occ of list){
      const el = document.createElement('div');
      el.className = 'occ-box';
      el.dataset.id = occ.id;
      el.style.position = 'absolute';
      el.style.left = `${occ.x * 100}%`;
      el.style.top = `${occ.y * 100}%`;
      el.style.width = `${occ.w * 100}%`;
      el.style.height = `${occ.h * 100}%`;
      el.style.cursor = 'pointer';
      el.style.transition = 'opacity 0.12s';
      el.title = occ.label || '';
      applyBlanketStyle(el);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if(mode === 'add') return;
        const revealed = el.dataset.revealed === '1';
        el.dataset.revealed = revealed ? '0' : '1';
        el.style.opacity = revealed ? '1' : '0';
        onSelect && onSelect(occ);
      });
      layer.appendChild(el);
    }
  }

  /** Called by renderer.js's onPageRendered, once the canvas for a page exists. */
  function attachToPage(pageNumber, wrapper){
    let layer = layerByPage.get(pageNumber);
    if(!layer){
      layer = document.createElement('div');
      layer.className = 'occ-layer';
      layer.style.position = 'absolute';
      layer.style.inset = '0';
      wrapper.appendChild(layer);
      layerByPage.set(pageNumber, layer);
      attachDrawHandlers(pageNumber, layer, wrapper);
    } else if(layer.parentElement !== wrapper){
      wrapper.appendChild(layer);
    }
    renderOcclusions(pageNumber, layer);
  }

  function detachFromPage(pageNumber){
    // keep occlusion data cached; just drop the DOM layer reference since the
    // wrapper's canvas (and everything in it) was torn down by the renderer
    layerByPage.delete(pageNumber);
  }

  function attachDrawHandlers(pageNumber, layer, wrapper){
    let dragStart = null;
    let draftEl = null;

    layer.addEventListener('pointerdown', (e) => {
      if(mode !== 'add') return;
      if(e.target.closest('.occ-box')) return;
      const rect = wrapper.getBoundingClientRect();
      dragStart = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
      draftEl = document.createElement('div');
      draftEl.style.position = 'absolute';
      draftEl.style.border = '2px dashed var(--accent)';
      draftEl.style.background = 'rgba(42,111,119,0.15)';
      draftEl.style.left = `${dragStart.x * 100}%`;
      draftEl.style.top = `${dragStart.y * 100}%`;
      layer.appendChild(draftEl);
      layer.setPointerCapture(e.pointerId);
    });

    layer.addEventListener('pointermove', (e) => {
      if(!dragStart || !draftEl) return;
      const rect = wrapper.getBoundingClientRect();
      const curX = (e.clientX - rect.left) / rect.width;
      const curY = (e.clientY - rect.top) / rect.height;
      const x = Math.max(0, Math.min(dragStart.x, curX));
      const y = Math.max(0, Math.min(dragStart.y, curY));
      const w = Math.min(1, Math.abs(curX - dragStart.x));
      const h = Math.min(1, Math.abs(curY - dragStart.y));
      draftEl.style.left = `${x * 100}%`;
      draftEl.style.top = `${y * 100}%`;
      draftEl.style.width = `${w * 100}%`;
      draftEl.style.height = `${h * 100}%`;
      draftEl.dataset.x = x; draftEl.dataset.y = y; draftEl.dataset.w = w; draftEl.dataset.h = h;
    });

    layer.addEventListener('pointerup', () => {
      if(draftEl && dragStart){
        const { x, y, w, h } = draftEl.dataset;
        draftEl.remove();
        if(parseFloat(w) > 0.01 && parseFloat(h) > 0.01){
          onCreate && onCreate({ pageNumber, x:parseFloat(x), y:parseFloat(y), w:parseFloat(w), h:parseFloat(h) });
        }
      }
      dragStart = null; draftEl = null;
    });
  }

  return { setMode, getMode, setBlanketStyle, setOcclusionsForPage, attachToPage, detachFromPage };
}
