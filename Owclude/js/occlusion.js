/* =============================================================================
   occlusion.js — the occlusion overlay layer.

   Occlusions are absolutely-positioned <div>s over the page canvas, in
   normalized (0-1) coords so they survive zoom/rerender for free.

   Visibility model:
     - hidden solid:     filled accent-dark + solid border
     - hidden transparent: translucent fill + white dashed border
     - active (next up):  the mask that will reveal next, in a DISTINCT color
                          so you always know which one is live
     - revealed:         ghost outline (still visible, still clickable)
     - hint shown:       dashes/hint text sized to fit the mask width
     - draft (unsaved):  RED dashed outline, painted immediately on drag-end,
                          persists until Save or Ctrl+Z

   Reveal is in CREATION ORDER, one at a time -- not hover. After each reveal
   the next mask is highlighted active. W reveals the hint for the active mask.
   ============================================================================= */

function createOcclusionLayer({ onCreate, onSelect, onDraftCancel }){
  let mode = 'view';                 // 'view' | 'add'
  let blanketStyle = 'solid';
  const occlusionsByPage = new Map(); // pageNumber -> occlusion[] (sorted by createdAt)
  const layerByPage = new Map();
  const activeByPage = new Map();      // pageNumber -> id of the next-to-reveal mask
  let draftInfo = null;                // { pageNumber, el } for the current red draft

  function setMode(m){
    mode = m;
    for(const layer of layerByPage.values()){
      layer.classList.toggle('occ-layer-add', mode === 'add');
    }
  }
  function getMode(){ return mode; }

  function setBlanketStyle(style){
    blanketStyle = style;
    for(const [pageNumber, layer] of layerByPage){
      layer.querySelectorAll('.occ-box').forEach(el => applyVisual(el, pageNumber));
    }
  }

  // ---- how each box looks, given its state and whether it's the active one ----
  function applyVisual(el, pageNumber){
    const revealed = el.dataset.revealed === '1';
    const isActive = activeByPage.get(pageNumber) === el.dataset.id;

    if(revealed){
      el.style.background = 'rgba(42,111,119,0.10)';
      el.style.border = '1.5px dashed var(--accent)';
      el.style.opacity = '1';
      return;
    }
    if(isActive){
      // distinct "you are here" color for the next mask to be revealed
      el.style.background = '#C25A2E';                 // warm accent, distinct from teal
      el.style.border = '2px solid #7A3216';
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

  // ---- hint: dashes/text sized to fit the mask, toggled per-box ----
  function renderHint(el, occ){
    let hintEl = el.querySelector('.occ-hint');
    const shown = el.dataset.hintShown === '1';
    if(!shown){ if(hintEl) hintEl.remove(); return; }
    if(!hintEl){
      hintEl = document.createElement('div');
      hintEl.className = 'occ-hint';
      el.appendChild(hintEl);
    }
    // If a hint string exists, show it; otherwise show dashes sized to the
    // mask width (auto "how many letters fit"). ~8px per mono char at 13px.
    if(occ.hint && occ.hint.trim()){
      hintEl.textContent = occ.hint;
    } else {
      const pxWidth = el.clientWidth || 40;
      const approxChars = Math.max(2, Math.floor(pxWidth / 9));
      hintEl.textContent = '-'.repeat(approxChars);
    }
  }

  function setOcclusionsForPage(pageNumber, occlusions){
    // keep them in creation order so reveal + active tracking is deterministic
    const sorted = [...occlusions].sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
    occlusionsByPage.set(pageNumber, sorted);
    // active mask = first not-yet-revealed one (recomputed on render)
    const layer = layerByPage.get(pageNumber);
    if(layer) renderOcclusions(pageNumber, layer);
  }

  function recomputeActive(pageNumber){
    const layer = layerByPage.get(pageNumber);
    if(!layer) return;
    const boxes = [...layer.querySelectorAll('.occ-box')];
    const nextHidden = boxes.find(b => b.dataset.revealed !== '1');
    activeByPage.set(pageNumber, nextHidden ? nextHidden.dataset.id : null);
    boxes.forEach(b => applyVisual(b, pageNumber));
  }

  function setRevealed(el, pageNumber, revealed){
    el.dataset.revealed = revealed ? '1' : '0';
    el.setAttribute('aria-pressed', revealed ? 'true' : 'false');
    applyVisual(el, pageNumber);
    recomputeActive(pageNumber);
  }

  function toggleRevealed(el, pageNumber){
    setRevealed(el, pageNumber, el.dataset.revealed !== '1');
  }

  function setAllRevealed(pageNumber, revealed){
    const layer = layerByPage.get(pageNumber);
    if(!layer) return;
    layer.querySelectorAll('.occ-box').forEach(el => { el.dataset.revealed = revealed ? '1':'0'; el.setAttribute('aria-pressed', revealed?'true':'false'); });
    recomputeActive(pageNumber);
  }

  // Reveal the NEXT mask in creation order (the active one). Returns the occ.
  function revealNext(pageNumber){
    const layer = layerByPage.get(pageNumber);
    if(!layer) return null;
    const activeId = activeByPage.get(pageNumber);
    if(!activeId) return null;
    const el = layer.querySelector('.occ-box[data-id="'+activeId+'"]');
    if(!el) return null;
    setRevealed(el, pageNumber, true);
    const list = occlusionsByPage.get(pageNumber) || [];
    return list.find(o => o.id === activeId) || null;
  }

  // Toggle the hint on the ACTIVE mask (bound to W).
  function toggleHintOnActive(pageNumber){
    const layer = layerByPage.get(pageNumber);
    if(!layer) return;
    const activeId = activeByPage.get(pageNumber);
    if(!activeId) return;
    const el = layer.querySelector('.occ-box[data-id="'+activeId+'"]');
    if(!el) return;
    el.dataset.hintShown = el.dataset.hintShown === '1' ? '0' : '1';
    const occ = (occlusionsByPage.get(pageNumber) || []).find(o => o.id === activeId);
    if(occ) renderHint(el, occ);
  }

  function renderOcclusions(pageNumber, layer){
    layer.querySelectorAll('.occ-box').forEach(el => el.remove());
    const list = occlusionsByPage.get(pageNumber) || [];
    for(const occ of list){
      const el = document.createElement('div');
      el.className = 'occ-box';
      el.dataset.id = occ.id;
      el.dataset.revealed = '0';
      el.dataset.hintShown = '0';
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
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.overflow = 'hidden';
      el.style.transition = 'background 0.12s, border-color 0.12s';
      el.style.outlineOffset = '2px';
      el.title = occ.label || '';

      // bulb toggle in the box's top-right corner
      const bulb = document.createElement('button');
      bulb.className = 'occ-bulb';
      bulb.type = 'button';
      bulb.textContent = '\u{1F4A1}'; // bulb
      bulb.title = 'Show/hide hint';
      bulb.setAttribute('aria-label', 'Show or hide hint');
      bulb.addEventListener('click', (e) => {
        e.stopPropagation();
        el.dataset.hintShown = el.dataset.hintShown === '1' ? '0' : '1';
        renderHint(el, occ);
      });
      el.appendChild(bulb);

      applyVisual(el, pageNumber);

      const activate = (e) => {
        e.stopPropagation();
        if(mode === 'add') return;
        if(e.target.closest('.occ-bulb')) return;
        toggleRevealed(el, pageNumber);
        onSelect && onSelect(occ);
      };
      el.addEventListener('click', activate);
      el.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); activate(e); }
      });
      layer.appendChild(el);
    }
    recomputeActive(pageNumber);
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
    // re-paint a persisted draft if its page just remounted
    if(draftInfo && draftInfo.pageNumber === pageNumber){
      paintDraft(pageNumber, draftInfo.rect);
    }
  }

  function detachFromPage(pageNumber){
    layerByPage.delete(pageNumber);
  }

  // ---- draft: red dashed outline painted immediately, until Save/Ctrl+Z ----
  function paintDraft(pageNumber, rect){
    const layer = layerByPage.get(pageNumber);
    if(!layer) return;
    clearDraftEl();
    const el = document.createElement('div');
    el.className = 'occ-draft-persist';
    el.style.position = 'absolute';
    el.style.boxSizing = 'border-box';
    el.style.left = (rect.x * 100) + '%';
    el.style.top = (rect.y * 100) + '%';
    el.style.width = (rect.w * 100) + '%';
    el.style.height = (rect.h * 100) + '%';
    el.style.border = '2px dashed #D33A3A';
    el.style.background = 'rgba(211,58,58,0.12)';
    el.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.9)';
    el.style.pointerEvents = 'none';
    layer.appendChild(el);
    draftInfo = { pageNumber, rect, el };
  }

  function clearDraftEl(){
    for(const layer of layerByPage.values()){
      layer.querySelectorAll('.occ-draft-persist').forEach(n => n.remove());
    }
  }

  function clearDraft(){
    clearDraftEl();
    draftInfo = null;
  }

  function attachDrawHandlers(pageNumber, layer, wrapper){
    let dragStart = null;
    let draftEl = null;
    let sizeTag = null;
    let cachedRect = null;

    layer.addEventListener('pointerdown', (e) => {
      if(mode !== 'add') return;
      cachedRect = wrapper.getBoundingClientRect();
      dragStart = {
        x: (e.clientX - cachedRect.left) / cachedRect.width,
        y: (e.clientY - cachedRect.top) / cachedRect.height,
      };
      draftEl = document.createElement('div');
      draftEl.style.position = 'absolute';
      draftEl.style.boxSizing = 'border-box';
      draftEl.style.border = '2px dashed #D33A3A';
      draftEl.style.background = 'rgba(211,58,58,0.15)';
      draftEl.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.9)';
      draftEl.style.left = (dragStart.x * 100) + '%';
      draftEl.style.top = (dragStart.y * 100) + '%';
      layer.appendChild(draftEl);

      sizeTag = document.createElement('div');
      sizeTag.style.position = 'absolute';
      sizeTag.style.font = "500 11px 'IBM Plex Mono', monospace";
      sizeTag.style.background = '#D33A3A';
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

      const pxW = Math.round(w * cachedRect.width);
      const pxH = Math.round(h * cachedRect.height);
      sizeTag.textContent = pxW + ' x ' + pxH;
      sizeTag.style.left = (x * 100) + '%';
      sizeTag.style.top = (y * 100) + '%';
    });

    function finishDraw(){
      if(draftEl && dragStart){
        const dx = draftEl.dataset.x, dy = draftEl.dataset.y, dw = draftEl.dataset.w, dh = draftEl.dataset.h;
        draftEl.remove();
        if(sizeTag) sizeTag.remove();
        if(dw !== undefined && parseFloat(dw) > 0.008 && parseFloat(dh) > 0.008){
          const rect = { x:parseFloat(dx), y:parseFloat(dy), w:parseFloat(dw), h:parseFloat(dh) };
          paintDraft(pageNumber, rect);           // <-- red outline stays now
          onCreate && onCreate({ pageNumber, ...rect });
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
    revealNext, toggleHintOnActive, clearDraft,
  };
}
