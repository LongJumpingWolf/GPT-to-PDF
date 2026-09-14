/* =============================================================================
   occlusion.js — the occlusion overlay layer.

   Occlusions are NEVER baked into the canvas bitmap. They're absolutely-
   positioned <div>s in a wrapper the same size as the page canvas, using
   normalized (0-1) coordinates so they survive zoom/rerender for free.

   Visibility model (every state has a VISIBLE border so edges are always
   defined -- this is the whole point of the rewrite):
     - hidden solid mask:  filled accent-dark + solid border
     - hidden transparent: translucent fill + solid dashed border (content
                           shows through but the region is clearly a mask)
     - revealed mask:      NOT invisible -- it goes to a thin outlined ghost
                           so you can still see where it was and click to
                           re-hide it. This is what standard occluders do.
     - draft (drawing):    bright dashed border + tint + live size readout,
                           with an add-mode class on the layer that shows a
                           crosshair cursor so you always know you're drawing.

   Boxes are real buttons: role/tabindex/aria + Enter/Space toggle.
   Drag rect caches the wrapper rect at pointerdown so a box can't land
   offset if the scroll container shifts mid-drag.
   ============================================================================= */

function createOcclusionLayer({ onCreate, onSelect }){
  let mode = 'view';                 // 'view' | 'add'
  let blanketStyle = 'solid';        // 'solid' | 'transparent'
  const occlusionsByPage = new Map(); // pageNumber -> occlusion[]
  const layerByPage = new Map();      // pageNumber -> overlay <div>

  function setMode(m){
    mode = m;
    // toggle the crosshair-cursor / draw affordance on every mounted layer
    for(const layer of layerByPage.values()){
      layer.classList.toggle('occ-layer-add', mode === 'add');
    }
  }
  function getMode(){ return mode; }

  function setBlanketStyle(style){
    blanketStyle = style;
    for(const layer of layerByPage.values()){
      layer.querySelectorAll('.occ-box').forEach(el => applyVisual(el));
    }
  }

  // Single source of truth for how a box looks in every state.
  function applyVisual(el){
    const revealed = el.dataset.revealed === '1';
    if(revealed){
      // ghost: clearly visible outline, mostly see-through, still clickable
      el.style.background = 'rgba(42,111,119,0.10)';
      el.style.border = '1.5px dashed var(--accent)';
      el.style.opacity = '1';
      return;
    }
    if(blanketStyle === 'transparent'){
      el.style.background = 'rgba(27,39,51,0.45)';
      el.style.border = '2px dashed rgba(255,255,255,0.85)';
    } else {
      el.style.background = 'var(--text)';
      el.style.border = '1.5px solid var(--accent)';
    }
    el.style.opacity = '1';
  }

  function setOcclusionsForPage(pageNumber, occlusions){
    occlusionsByPage.set(pageNumber, occlusions);
    const layer = layerByPage.get(pageNumber);
    if(layer) renderOcclusions(pageNumber, layer);
  }

  function setRevealed(el, revealed){
    el.dataset.revealed = revealed ? '1' : '0';
    el.setAttribute('aria-pressed', revealed ? 'true' : 'false');
    applyVisual(el);
  }

  function toggleRevealed(el){
    setRevealed(el, el.dataset.revealed !== '1');
  }

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
      el.style.boxSizing = 'border-box';
      el.style.cursor = 'pointer';
      el.style.transition = 'background 0.12s, border-color 0.12s';
      el.style.outlineOffset = '2px';
      el.title = occ.label || '';
      applyVisual(el);

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
      layer.classList.toggle('occ-layer-add', mode === 'add');
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
    let sizeTag = null;
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
      draftEl.className = 'occ-draft';
      draftEl.style.position = 'absolute';
      draftEl.style.boxSizing = 'border-box';
      draftEl.style.border = '2px dashed var(--accent)';
      draftEl.style.background = 'rgba(42,111,119,0.20)';
      draftEl.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.9)'; // halo so the dashes read on dark text
      draftEl.style.left = (dragStart.x * 100) + '%';
      draftEl.style.top = (dragStart.y * 100) + '%';
      layer.appendChild(draftEl);

      // live pixel-size readout that follows the cursor corner
      sizeTag = document.createElement('div');
      sizeTag.className = 'occ-size-tag';
      sizeTag.style.position = 'absolute';
      sizeTag.style.font = "500 11px 'IBM Plex Mono', monospace";
      sizeTag.style.background = 'var(--accent)';
      sizeTag.style.color = '#fff';
      sizeTag.style.padding = '1px 5px';
      sizeTag.style.pointerEvents = 'none';
      sizeTag.style.whiteSpace = 'nowrap';
      sizeTag.style.transform = 'translateY(-100%)';
      layer.appendChild(sizeTag);

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

      // size readout in real pixels, anchored just above the box's top-left
      const pxW = Math.round(w * cachedRect.width);
      const pxH = Math.round(h * cachedRect.height);
      sizeTag.textContent = pxW + ' x ' + pxH;
      sizeTag.style.left = (x * 100) + '%';
      sizeTag.style.top = (y * 100) + '%';
    });

    function finishDraw(){
      if(draftEl && dragStart){
        const { x, y, w, h } = draftEl.dataset;
        draftEl.remove();
        if(sizeTag) sizeTag.remove();
        if(w !== undefined && parseFloat(w) > 0.008 && parseFloat(h) > 0.008){
          onCreate && onCreate({ pageNumber, x:parseFloat(x), y:parseFloat(y), w:parseFloat(w), h:parseFloat(h) });
        }
      }
      dragStart = null; draftEl = null; sizeTag = null; cachedRect = null;
    }

    layer.addEventListener('pointerup', finishDraw);
    layer.addEventListener('pointercancel', finishDraw);
  }

  return {
    setMode, getMode, setBlanketStyle, setOcclusionsForPage,
    attachToPage, detachFromPage, setAllRevealed,
  };
}
