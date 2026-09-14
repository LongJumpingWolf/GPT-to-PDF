/* =============================================================================
   occlusion.js — the occlusion overlay layer.

   Occlusions are NEVER baked into the canvas bitmap. They're absolutely-
   positioned <div>s in a wrapper the same size as the page canvas, using
   normalized (0-1) coordinates so they survive zoom/rerender for free.

   Changes over the first version:
     - Drag rect now caches the wrapper rect at pointerdown instead of
       re-reading getBoundingClientRect() on every move, so a box no longer
       lands offset if the scroll container shifts mid-drag.
     - Reveal is a per-page mode: 'hide-all' (every mask covered, the standard
       occluder default) vs 'peek' (click a single mask to toggle it). A
       reveal-all / hide-all toggle flips the whole current page at once.
     - Boxes are real buttons: role="button", tabindex, aria-label from the
       label, and Enter/Space toggle them — keyboard-operable and screen-
       reader-announced.
   ============================================================================= */

function createOcclusionLayer({ onCreate, onSelect }){
  let mode = 'view';                 // 'view' | 'add'
  let blanketStyle = 'solid';        // 'solid' | 'transparent'
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
    const revealed = el.dataset.revealed === '1';
    if(revealed){ el.style.background = 'transparent'; return; }
    el.style.background = blanketStyle === 'transparent'
      ? 'rgba(27,39,51,0.35)'
      : 'var(--text)';
  }

  function setOcclusionsForPage(pageNumber, occlusions){
    occlusionsByPage.set(pageNumber, occlusions);
    const layer = layerByPage.get(pageNumber);
    if(layer) renderOcclusions(pageNumber, layer);
  }

  function setRevealed(el, revealed){
    el.dataset.revealed = revealed ? '1' : '0';
    el.style.opacity = revealed ? '0' : '1';
    el.setAttribute('aria-pressed', revealed ? 'true' : 'false');
    applyBlanketStyle(el);
  }

  function toggleRevealed(el){
    setRevealed(el, el.dataset.revealed !== '1');
  }

  // reveal or hide EVERY mask on a page at once (the standard "toggle masks")
  function setAllRevealed(pageNumber, revealed){
    const layer = layerByPage.get(pageNumber);
    if(!layer) return;
    layer.querySelectorAll('.occ-box').forEach(el => setRevealed(el, revealed));
  }

  function renderOcclusions(pageNumber, layer){
    layer.querySelectorAll('.occ-box').forEach(el => el.remove());
    const list = occlusionsByPage.get(pageNumber) || [];
    for(const occ of list){
      const el = document.createElement('div');
      el.className = 'occ-box';
      el.dataset.id = occ.id;
      el.dataset.revealed = '0';
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-pressed', 'false');
      el.setAttribute('aria-label', occ.label ? ('Occlusion: ' + occ.label) : 'Occlusion, no label');
      el.style.position = 'absolute';
      el.style.left = (occ.x * 100) + '%';
      el.style.top = (occ.y * 100) + '%';
      el.style.width = (occ.w * 100) + '%';
      el.style.height = (occ.h * 100) + '%';
      el.style.cursor = 'pointer';
      el.style.transition = 'opacity 0.12s';
      el.style.outlineOffset = '2px';
      el.title = occ.label || '';
      applyBlanketStyle(el);

      const activate = (e) => {
        e.stopPropagation();
        if(mode === 'add') return;
        toggleRevealed(el);
        onSelect && onSelect(occ);
      };
      el.addEventListener('click', activate);
      el.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); activate(e); }
      });
      layer.appendChild(el);
    }
  }

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
    layerByPage.delete(pageNumber);
  }

  function attachDrawHandlers(pageNumber, layer, wrapper){
    let dragStart = null;
    let draftEl = null;
    let cachedRect = null; // captured once at pointerdown, not re-read per move

    layer.addEventListener('pointerdown', (e) => {
      if(mode !== 'add') return;
      if(e.target.closest('.occ-box')) return;
      cachedRect = wrapper.getBoundingClientRect();
      dragStart = {
        x: (e.clientX - cachedRect.left) / cachedRect.width,
        y: (e.clientY - cachedRect.top) / cachedRect.height,
      };
      draftEl = document.createElement('div');
      draftEl.style.position = 'absolute';
      draftEl.style.border = '2px dashed var(--accent)';
      draftEl.style.background = 'rgba(42,111,119,0.15)';
      draftEl.style.left = (dragStart.x * 100) + '%';
      draftEl.style.top = (dragStart.y * 100) + '%';
      layer.appendChild(draftEl);
      layer.setPointerCapture(e.pointerId);
    });

    layer.addEventListener('pointermove', (e) => {
      if(!dragStart || !draftEl || !cachedRect) return;
      const curX = (e.clientX - cachedRect.left) / cachedRect.width;
      const curY = (e.clientY - cachedRect.top) / cachedRect.height;
      const x = Math.max(0, Math.min(dragStart.x, curX));
      const y = Math.max(0, Math.min(dragStart.y, curY));
      const w = Math.min(1 - x, Math.abs(curX - dragStart.x));
      const h = Math.min(1 - y, Math.abs(curY - dragStart.y));
      draftEl.style.left = (x * 100) + '%';
      draftEl.style.top = (y * 100) + '%';
      draftEl.style.width = (w * 100) + '%';
      draftEl.style.height = (h * 100) + '%';
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
      dragStart = null; draftEl = null; cachedRect = null;
    });
  }

  return {
    setMode, getMode, setBlanketStyle, setOcclusionsForPage,
    attachToPage, detachFromPage, setAllRevealed,
  };
}
