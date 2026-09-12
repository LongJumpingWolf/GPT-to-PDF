/* =============================================================================
   canvas.js — the "freeflow" canvas column type.

   Loaded after columns.js (uses CANVAS_MARKER/escapeHtml) and before
   index.html's own script, which defines the shared app state
   (columns/activeCol/render/idbGet/imgMetaCache/isImageFile/
   storeImageBlobFromFile/statusEl) that the interactive editor functions
   below reference. Safe per the cross-file convention used throughout
   this app: those references only resolve when a function is actually
   CALLED (a click, a drag), never at load time.
   ============================================================================= */

function parseCanvasData(text){
  try{
    const json = (text || '').slice(CANVAS_MARKER.length).replace(/^\n/, '');
    const data = JSON.parse(json);
    return {
      width: (typeof data.width === 'number' && data.width > 0) ? data.width : 720,
      height: (typeof data.height === 'number' && data.height > 0) ? data.height : 480,
      elements: Array.isArray(data.elements) ? data.elements : []
    };
  }catch(e){
    return { width:720, height:480, elements:[] };
  }
}
function serializeCanvasData(data){
  return CANVAS_MARKER + '\n' + JSON.stringify({ width:data.width, height:data.height, elements:data.elements });
}
function defaultCanvasText(){
  return serializeCanvasData({ width:720, height:480, elements:[] });
}

// ---- Pure data-transform function - the part most worth testing
// rigorously, since a math mistake here would silently misplace
// someone's content rather than throw an error. ----

// Extends the canvas in one direction. Extending right/bottom just grows
// the canvas; extending left/top ALSO shifts every element's position by
// the same amount, so existing content stays visually anchored in place
// while new blank space opens up on the specified edge - the same
// convention Photoshop's "Canvas Size" dialog uses, rather than content
// silently sliding to a new position relative to the (moved) origin.
function addCanvasSpace(data, direction, amount){
  const amt = Math.max(0, Math.round(Number(amount)) || 0);
  const next = { width:data.width, height:data.height, elements: data.elements.map(el => Object.assign({}, el)) };
  if(amt === 0) return next;
  if(direction === 'left'){
    next.width += amt;
    next.elements.forEach(el => { el.x += amt; });
  } else if(direction === 'right'){
    next.width += amt;
  } else if(direction === 'top'){
    next.height += amt;
    next.elements.forEach(el => { el.y += amt; });
  } else if(direction === 'bottom'){
    next.height += amt;
  }
  return next;
}

// ---- Text box formatting: bold, italic, font size, text color,
// highlight. Applies to a whole box's text uniformly (not per-character
// ranges within it - that would need a much heavier rich-text editing
// model for comparatively little value here). Stored directly on the
// element object itself (el.format), not a separate sparse map like
// sheet cell formatting - so add/delete/duplicate/reorder/layer
// operations, which already copy or filter whole element objects,
// automatically carry formatting along with zero extra code.
function pruneCanvasTextFormat(fmt){
  if(!fmt) return null;
  const hasAny = fmt.bold || fmt.italic || fmt.fontSize || fmt.color || fmt.highlight;
  return hasAny ? fmt : null;
}
// Applies one formatting property to every TEXT element among `ids`
// (image elements are silently skipped, not an error - selecting a mix
// of text and image elements and clicking Bold should format the text
// ones, not fail entirely because an image was included).
function applyCanvasTextFormat(data, ids, prop, value){
  const idSet = new Set(ids);
  const elements = data.elements.map(el => {
    if(el.type !== 'text' || !idSet.has(el.id)) return el;
    const updated = Object.assign({}, el.format, { [prop]: value });
    const pruned = pruneCanvasTextFormat(updated);
    const next = Object.assign({}, el);
    if(pruned) next.format = pruned; else delete next.format;
    return next;
  });
  return { width:data.width, height:data.height, elements };
}
// Toggle semantics matching the sheet cell toggle: if EVERY targeted
// text element already has the property on, turn it off for all of
// them; otherwise turn it on for all of them.
function toggleCanvasTextFormat(data, ids, prop){
  const textEls = data.elements.filter(el => el.type === 'text' && ids.includes(el.id));
  const allOn = textEls.length > 0 && textEls.every(el => el.format && el.format[prop]);
  return applyCanvasTextFormat(data, ids, prop, !allOn);
}
function canvasTextStyleAttr(format){
  if(!format) return '';
  const styles = [];
  if(format.bold) styles.push('font-weight:700');
  if(format.italic) styles.push('font-style:italic');
  if(format.fontSize) styles.push('font-size:' + format.fontSize + 'px');
  if(format.color) styles.push('color:' + format.color);
  if(format.highlight) styles.push('background:' + format.highlight);
  return styles.join(';');
}

// ---- Static (non-interactive) rendering for the preview pane / PDF
// export - reuses resolveImages() (via the img://<id> src convention)
// exactly like markdown images do, so canvas images get the same
// lossless-storage and "image unavailable" fallback handling for free.
function renderCanvasHTML(data){
  const elementsHtml = data.elements.map(el => {
    const style = `left:${el.x}px;top:${el.y}px;width:${el.width}px;height:${el.height}px;`;
    if(el.type === 'text'){
      const fmtStyle = canvasTextStyleAttr(el.format);
      const combined = style + (fmtStyle ? fmtStyle : '');
      return `<div class="canvas-el canvas-el-text" style="${combined}">${escapeHtml(el.text || '')}</div>`;
    }
    if(el.type === 'image'){
      return `<div class="canvas-el canvas-el-image" style="${style}"><img src="${escapeHtml(el.src || '')}" alt=""></div>`;
    }
    return '';
  }).join('');
  return `<div class="canvas-page" style="width:${data.width}px;height:${data.height}px;">${elementsHtml}</div>`;
}

/* =========================================================================
   Canvas (freeflow) interactive editor - drag/resize text boxes and
   images anywhere, click/shift-click/drag-box to select, keyboard
   delete, duplicate, layer ordering, and undo/redo for structural
   changes (move/resize/delete/add/reorder). All persistence goes
   through saveCanvasData(), which serializes back into
   columns[activeCol] via the same string-based representation the
   static preview renderer reads - there is no separate "live"
   in-memory canvas state that could drift from what's actually saved.
   ========================================================================= */
function getCurrentCanvasData(){
  return parseCanvasData(columns[activeCol] || '');
}

// Typing inside a text box already has its own undo (native browser
// undo within that focused textarea, since the user is typing directly
// into it) - this path is deliberately "quiet": it does NOT push a
// structural undo snapshot, otherwise the undo stack would fill with
// one entry per keystroke, crowding out the actually-useful
// move/resize/delete/add history the app-level undo is for.
function saveCanvasDataQuiet(data){
  columns[activeCol] = serializeCanvasData(data);
  render();
}
// The structural save path - drag-end, resize-end, delete, duplicate,
// add text/image, space, layer reorder. Pushes the PRE-mutation state
// onto the undo stack before overwriting it.
function saveCanvasData(data){
  if(getColumnType(columns[activeCol]) === 'canvas'){
    canvasUndoStack.push(columns[activeCol]);
    if(canvasUndoStack.length > CANVAS_UNDO_LIMIT) canvasUndoStack.shift();
    canvasRedoStack = [];
  }
  columns[activeCol] = serializeCanvasData(data);
  render();
}
function newElementId(){
  return crypto.randomUUID ? crypto.randomUUID() : ('el-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

// Resolves an img://<id> reference to a displayable blob URL, reusing
// the same cache resolveImages() populates - a canvas image and a
// markdown image referencing the same id share one cached object URL
// rather than creating a second one.
async function resolveSingleImageSrc(srcRef){
  if(!srcRef || !srcRef.startsWith('img://')) return null;
  const id = srcRef.slice('img://'.length);
  let meta = imgMetaCache.get(id);
  if(!meta){
    const rec = await idbGet('images', id);
    if(rec && rec.blob){
      meta = { url: URL.createObjectURL(rec.blob), width: rec.width || null, height: rec.height || null };
      imgMetaCache.set(id, meta);
    }
  }
  return meta ? meta.url : null;
}

/* ---- Layer ordering (pure - element position in the array IS the
   z-order, since default stacking follows DOM order). ---- */
function bringElementToFront(data, id){
  const idx = data.elements.findIndex(e => e.id === id);
  if(idx === -1) return data;
  const elements = data.elements.slice();
  const moved = elements.splice(idx, 1)[0];
  elements.push(moved);
  return { width:data.width, height:data.height, elements };
}
function sendElementToBack(data, id){
  const idx = data.elements.findIndex(e => e.id === id);
  if(idx === -1) return data;
  const elements = data.elements.slice();
  const moved = elements.splice(idx, 1)[0];
  elements.unshift(moved);
  return { width:data.width, height:data.height, elements };
}
function bringElementForward(data, id){
  const idx = data.elements.findIndex(e => e.id === id);
  if(idx === -1 || idx === data.elements.length - 1) return data;
  const elements = data.elements.slice();
  const tmp = elements[idx]; elements[idx] = elements[idx+1]; elements[idx+1] = tmp;
  return { width:data.width, height:data.height, elements };
}
function sendElementBackward(data, id){
  const idx = data.elements.findIndex(e => e.id === id);
  if(idx <= 0) return data;
  const elements = data.elements.slice();
  const tmp = elements[idx]; elements[idx] = elements[idx-1]; elements[idx-1] = tmp;
  return { width:data.width, height:data.height, elements };
}

/* ---- Duplicate (pure aside from id generation). ---- */
function duplicateCanvasElements(data, ids, offset){
  offset = (typeof offset === 'number') ? offset : 20;
  const elements = data.elements.slice();
  const newIds = [];
  ids.forEach(id => {
    const orig = data.elements.find(e => e.id === id);
    if(!orig) return;
    const copy = Object.assign({}, orig, { id: newElementId(), x: orig.x + offset, y: orig.y + offset });
    elements.push(copy);
    newIds.push(copy.id);
  });
  return { data: { width:data.width, height:data.height, elements }, newIds };
}

/* ---- Multi-select rubber-band: pure geometry, kept separate from the
   DOM event choreography so the intersection math is testable without
   needing real mouse coordinates/layout (jsdom has neither). rect and
   each element are {x,y,width,height}; both use the same coordinate
   space (canvas-surface-relative pixels). ---- */
function elementsIntersectingRect(elements, rect){
  const rx0 = Math.min(rect.x0, rect.x1), rx1 = Math.max(rect.x0, rect.x1);
  const ry0 = Math.min(rect.y0, rect.y1), ry1 = Math.max(rect.y0, rect.y1);
  return elements
    .filter(el => el.x < rx1 && el.x + el.width > rx0 && el.y < ry1 && el.y + el.height > ry0)
    .map(el => el.id);
}

/* ---- Align / distribute / nudge - pure geometry, operating on
   whichever elements are in `ids`. ---- */
function alignElements(data, ids, mode){
  const idSet = new Set(ids);
  const targets = data.elements.filter(el => idSet.has(el.id));
  if(targets.length < 2) return data; // nothing meaningful to align against
  let ref;
  if(mode === 'left') ref = Math.min.apply(null, targets.map(el => el.x));
  else if(mode === 'right') ref = Math.max.apply(null, targets.map(el => el.x + el.width));
  else if(mode === 'hcenter'){
    const minX = Math.min.apply(null, targets.map(el => el.x));
    const maxX = Math.max.apply(null, targets.map(el => el.x + el.width));
    ref = (minX + maxX) / 2;
  } else if(mode === 'top') ref = Math.min.apply(null, targets.map(el => el.y));
  else if(mode === 'bottom') ref = Math.max.apply(null, targets.map(el => el.y + el.height));
  else if(mode === 'vcenter'){
    const minY = Math.min.apply(null, targets.map(el => el.y));
    const maxY = Math.max.apply(null, targets.map(el => el.y + el.height));
    ref = (minY + maxY) / 2;
  } else return data;

  const elements = data.elements.map(el => {
    if(!idSet.has(el.id)) return el;
    const next = Object.assign({}, el);
    if(mode === 'left') next.x = ref;
    else if(mode === 'right') next.x = ref - el.width;
    else if(mode === 'hcenter') next.x = ref - el.width / 2;
    else if(mode === 'top') next.y = ref;
    else if(mode === 'bottom') next.y = ref - el.height;
    else if(mode === 'vcenter') next.y = ref - el.height / 2;
    return next;
  });
  return { width:data.width, height:data.height, elements };
}
// Spaces elements evenly by CENTER-to-center distance between the
// first and last (by position along the chosen axis) - the two
// endpoints stay put, everything between them redistributes to equal
// spacing. Needs at least 3 elements; with only 2, "distribute" has no
// meaningful effect beyond what align already does.
function distributeElements(data, ids, axis){
  const idSet = new Set(ids);
  const targets = data.elements.filter(el => idSet.has(el.id));
  if(targets.length < 3) return data;
  const sorted = targets.slice().sort((a, b) => axis === 'horizontal' ? (a.x - b.x) : (a.y - b.y));
  const centerOf = (el) => axis === 'horizontal' ? (el.x + el.width / 2) : (el.y + el.height / 2);
  const firstCenter = centerOf(sorted[0]);
  const lastCenter = centerOf(sorted[sorted.length - 1]);
  const step = (lastCenter - firstCenter) / (sorted.length - 1);
  const newCenters = {};
  sorted.forEach((el, i) => {
    if(i === 0 || i === sorted.length - 1) return;
    newCenters[el.id] = firstCenter + step * i;
  });
  const elements = data.elements.map(el => {
    if(!(el.id in newCenters)) return el;
    const next = Object.assign({}, el);
    if(axis === 'horizontal') next.x = newCenters[el.id] - el.width / 2;
    else next.y = newCenters[el.id] - el.height / 2;
    return next;
  });
  return { width:data.width, height:data.height, elements };
}
function nudgeElements(data, ids, dx, dy){
  const idSet = (ids instanceof Set) ? ids : new Set(ids);
  const elements = data.elements.map(el => {
    if(!idSet.has(el.id)) return el;
    return Object.assign({}, el, { x: Math.max(0, el.x + dx), y: Math.max(0, el.y + dy) });
  });
  return { width:data.width, height:data.height, elements };
}

/* ---- Snap-to-alignment guides while dragging. Pure detection math,
   kept separate from the DOM drag choreography (which needs real
   layout/coordinates jsdom can't meaningfully simulate) so the actual
   snapping LOGIC is fully testable on its own. Checks the dragged
   box's edges/center against every other element's edges/center on
   each axis independently, snapping to whichever candidate is closest
   within `threshold` px. ---- */
function computeSnap(dragged, others, threshold){
  threshold = (typeof threshold === 'number') ? threshold : 5;
  const dPoints = {
    left: dragged.x, right: dragged.x + dragged.width, hcenter: dragged.x + dragged.width / 2,
    top: dragged.y, bottom: dragged.y + dragged.height, vcenter: dragged.y + dragged.height / 2
  };
  let bestX = null, bestY = null;
  others.forEach(other => {
    const oPoints = {
      left: other.x, right: other.x + other.width, hcenter: other.x + other.width / 2,
      top: other.y, bottom: other.y + other.height, vcenter: other.y + other.height / 2
    };
    ['left', 'right', 'hcenter'].forEach(dKey => {
      ['left', 'right', 'hcenter'].forEach(oKey => {
        const diff = oPoints[oKey] - dPoints[dKey];
        if(Math.abs(diff) <= threshold && (bestX === null || Math.abs(diff) < Math.abs(bestX.diff))){
          bestX = { diff, guideAt: oPoints[oKey] };
        }
      });
    });
    ['top', 'bottom', 'vcenter'].forEach(dKey => {
      ['top', 'bottom', 'vcenter'].forEach(oKey => {
        const diff = oPoints[oKey] - dPoints[dKey];
        if(Math.abs(diff) <= threshold && (bestY === null || Math.abs(diff) < Math.abs(bestY.diff))){
          bestY = { diff, guideAt: oPoints[oKey] };
        }
      });
    });
  });
  return {
    x: bestX ? dragged.x + bestX.diff : dragged.x,
    y: bestY ? dragged.y + bestY.diff : dragged.y,
    guideX: bestX ? bestX.guideAt : null,
    guideY: bestY ? bestY.guideAt : null
  };
}

/* ---- Undo/redo: canvas-scoped, reset whenever a different column or
   document is loaded (see resetCanvasUndoHistory(), called from
   loadActiveColumnIntoEditorUI() in index.html's script). ---- */
let canvasUndoStack = [];
let canvasRedoStack = [];
const CANVAS_UNDO_LIMIT = 50;
function resetCanvasUndoHistory(){
  canvasUndoStack = [];
  canvasRedoStack = [];
  updateCanvasUndoRedoButtons();
}
function updateCanvasUndoRedoButtons(){
  const undoBtn = document.getElementById('canvasUndoBtn');
  const redoBtn = document.getElementById('canvasRedoBtn');
  if(undoBtn) undoBtn.disabled = canvasUndoStack.length === 0;
  if(redoBtn) redoBtn.disabled = canvasRedoStack.length === 0;
}
function canvasUndo(){
  if(getColumnType(columns[activeCol]) !== 'canvas' || canvasUndoStack.length === 0) return;
  const current = columns[activeCol];
  const prev = canvasUndoStack.pop();
  canvasRedoStack.push(current);
  columns[activeCol] = prev;
  clearCanvasSelection();
  render();
  renderCanvasEditor(parseCanvasData(prev));
}
function canvasRedo(){
  if(getColumnType(columns[activeCol]) !== 'canvas' || canvasRedoStack.length === 0) return;
  const current = columns[activeCol];
  const next = canvasRedoStack.pop();
  canvasUndoStack.push(current);
  columns[activeCol] = next;
  clearCanvasSelection();
  render();
  renderCanvasEditor(parseCanvasData(next));
}

/* ---- Selection state and highlighting. ---- */
let selectedCanvasElementIds = new Set();
function selectedTextElementIds(data){
  return data.elements.filter(el => el.type === 'text' && selectedCanvasElementIds.has(el.id)).map(el => el.id);
}
// Reflects the (first) selected text element's formatting on the
// toolbar's Bold/Italic/font-size controls - a nice-to-have sync, not
// load-bearing for correctness (applying a format always targets the
// live selection regardless of what the toolbar currently displays).
function updateCanvasTextToolbarState(){
  const boldBtn = document.getElementById('canvasTextBoldBtn');
  const italicBtn = document.getElementById('canvasTextItalicBtn');
  const sizeSelect = document.getElementById('canvasFontSizeSelect');
  if(!boldBtn) return; // toolbar not in the DOM yet during very early init
  const data = getCurrentCanvasData();
  const ids = selectedTextElementIds(data);
  if(ids.length === 0){
    boldBtn.classList.remove('canvas-toolbar-btn-active');
    italicBtn.classList.remove('canvas-toolbar-btn-active');
    return;
  }
  const first = data.elements.find(el => el.id === ids[0]);
  const fmt = (first && first.format) || {};
  boldBtn.classList.toggle('canvas-toolbar-btn-active', !!fmt.bold);
  italicBtn.classList.toggle('canvas-toolbar-btn-active', !!fmt.italic);
  if(fmt.fontSize) sizeSelect.value = String(fmt.fontSize);
}
function refreshCanvasSelectionHighlight(){
  document.querySelectorAll('#canvasEditorSurface .canvas-el').forEach(el => {
    el.classList.toggle('selected', selectedCanvasElementIds.has(el.dataset.id));
  });
  updateCanvasTextToolbarState();
}
function selectCanvasElement(id, additive){
  if(!additive){
    selectedCanvasElementIds.clear();
    selectedCanvasElementIds.add(id);
  } else if(selectedCanvasElementIds.has(id)){
    selectedCanvasElementIds.delete(id); // shift-click an already-selected element toggles it off
  } else {
    selectedCanvasElementIds.add(id);
  }
  refreshCanvasSelectionHighlight();
}
function clearCanvasSelection(){
  selectedCanvasElementIds.clear();
  refreshCanvasSelectionHighlight();
}
function deleteSelectedCanvasElements(){
  if(selectedCanvasElementIds.size === 0) return;
  const data = getCurrentCanvasData();
  data.elements = data.elements.filter(el => !selectedCanvasElementIds.has(el.id));
  selectedCanvasElementIds.clear();
  saveCanvasData(data);
  renderCanvasEditor(data);
}

function showCanvasGuides(guideX, guideY){
  const surface = document.getElementById('canvasEditorSurface');
  let vLine = document.getElementById('canvasGuideV');
  let hLine = document.getElementById('canvasGuideH');
  if(guideX !== null){
    if(!vLine){ vLine = document.createElement('div'); vLine.id = 'canvasGuideV'; vLine.className = 'canvas-guide canvas-guide-v'; surface.appendChild(vLine); }
    vLine.style.left = guideX + 'px';
  } else if(vLine){ vLine.remove(); }
  if(guideY !== null){
    if(!hLine){ hLine = document.createElement('div'); hLine.id = 'canvasGuideH'; hLine.className = 'canvas-guide canvas-guide-h'; surface.appendChild(hLine); }
    hLine.style.top = guideY + 'px';
  } else if(hLine){ hLine.remove(); }
}
function hideCanvasGuides(){
  const v = document.getElementById('canvasGuideV'); if(v) v.remove();
  const h = document.getElementById('canvasGuideH'); if(h) h.remove();
}

function makeCanvasElDraggable(div, elId){
  div.addEventListener('mousedown', (e) => {
    if(e.target.closest('.canvas-resize-handle') || e.target.closest('.canvas-el-delete') || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    e.stopPropagation(); // don't let this also trigger the surface's box-select
    const startX = e.clientX, startY = e.clientY;
    const origLeft = parseFloat(div.style.left) || 0;
    const origTop = parseFloat(div.style.top) || 0;
    const width = parseFloat(div.style.width) || 100;
    const height = parseFloat(div.style.height) || 60;
    // Other elements' CURRENT positions, captured once at drag start
    // (not re-fetched every mousemove) - they aren't moving during a
    // single-element drag, so there's no need to re-read them.
    const others = getCurrentCanvasData().elements.filter(el => el.id !== elId);
    let moved = false;
    function onMove(ev){
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if(Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const rawX = Math.max(0, origLeft + dx), rawY = Math.max(0, origTop + dy);
      const snapped = computeSnap({ x:rawX, y:rawY, width, height }, others, 5);
      div.style.left = snapped.x + 'px';
      div.style.top = snapped.y + 'px';
      showCanvasGuides(snapped.guideX, snapped.guideY);
    }
    function onUp(upEvt){
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      hideCanvasGuides();
      if(moved){
        const data = getCurrentCanvasData();
        const target = data.elements.find(x => x.id === elId);
        if(target){
          target.x = parseFloat(div.style.left) || 0;
          target.y = parseFloat(div.style.top) || 0;
        }
        saveCanvasData(data);
      } else {
        // A click, not a drag - no position change to persist.
        div.style.left = origLeft + 'px';
        div.style.top = origTop + 'px';
      }
      selectCanvasElement(elId, !!upEvt.shiftKey);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// 8-direction resize. `edges` says which sides this particular handle
// controls (n/s/e/w, corners combine two). Holding Shift while resizing
// an IMAGE locks its aspect ratio - text boxes don't get this (their
// content reflows regardless of box shape, so there's no "correct"
// ratio to preserve the way there is for a photo).
function makeCanvasElResizable(handle, div, elId, edges){
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origLeft = parseFloat(div.style.left) || 0;
    const origTop = parseFloat(div.style.top) || 0;
    const origWidth = parseFloat(div.style.width) || 100;
    const origHeight = parseFloat(div.style.height) || 60;
    const aspectRatio = origWidth / (origHeight || 1);
    const isImage = div.classList.contains('canvas-el-image');
    function onMove(ev){
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let newLeft = origLeft, newTop = origTop, newWidth = origWidth, newHeight = origHeight;
      if(edges.e) newWidth = Math.max(20, origWidth + dx);
      if(edges.w){ newWidth = Math.max(20, origWidth - dx); newLeft = origLeft + (origWidth - newWidth); }
      if(edges.s) newHeight = Math.max(20, origHeight + dy);
      if(edges.n){ newHeight = Math.max(20, origHeight - dy); newTop = origTop + (origHeight - newHeight); }

      if(ev.shiftKey && isImage){
        if(edges.e || edges.w){
          newHeight = Math.max(20, newWidth / aspectRatio);
          if(edges.n) newTop = origTop + (origHeight - newHeight);
        } else if(edges.n || edges.s){
          newWidth = Math.max(20, newHeight * aspectRatio);
          if(edges.w) newLeft = origLeft + (origWidth - newWidth);
        }
      }
      div.style.left = newLeft + 'px'; div.style.top = newTop + 'px';
      div.style.width = newWidth + 'px'; div.style.height = newHeight + 'px';
    }
    function onUp(){
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const data = getCurrentCanvasData();
      const target = data.elements.find(x => x.id === elId);
      if(target){
        target.x = parseFloat(div.style.left) || 0;
        target.y = parseFloat(div.style.top) || 0;
        target.width = parseFloat(div.style.width) || 100;
        target.height = parseFloat(div.style.height) || 60;
      }
      saveCanvasData(data);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function buildCanvasElementDom(el){
  const div = document.createElement('div');
  div.className = 'canvas-el ' + (el.type === 'text' ? 'canvas-el-text' : 'canvas-el-image');
  if(selectedCanvasElementIds.has(el.id)) div.className += ' selected';
  div.dataset.id = el.id;
  div.style.left = el.x + 'px';
  div.style.top = el.y + 'px';
  div.style.width = el.width + 'px';
  div.style.height = el.height + 'px';

  if(el.type === 'text'){
    const ta = document.createElement('textarea');
    ta.value = el.text || '';
    if(el.format){
      if(el.format.bold) ta.style.fontWeight = '700';
      if(el.format.italic) ta.style.fontStyle = 'italic';
      if(el.format.fontSize) ta.style.fontSize = el.format.fontSize + 'px';
      if(el.format.color) ta.style.color = el.format.color;
      if(el.format.highlight) ta.style.background = el.format.highlight;
    }
    ta.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selectCanvasElement(el.id, e.shiftKey);
    });
    ta.addEventListener('input', () => {
      const data = getCurrentCanvasData();
      const target = data.elements.find(x => x.id === el.id);
      if(target) target.text = ta.value;
      saveCanvasDataQuiet(data);
    });
    div.appendChild(ta);
  } else if(el.type === 'image'){
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    resolveSingleImageSrc(el.src).then(url => { if(url) img.src = url; });
    div.appendChild(img);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'canvas-el-delete';
  del.textContent = '\u00d7';
  del.title = 'Delete';
  del.addEventListener('mousedown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    const data = getCurrentCanvasData();
    data.elements = data.elements.filter(x => x.id !== el.id);
    selectedCanvasElementIds.delete(el.id);
    saveCanvasData(data);
    renderCanvasEditor(data);
  });
  div.appendChild(del);

  const handleConfigs = [
    { cls:'nw', edges:{n:true, w:true} }, { cls:'n', edges:{n:true} }, { cls:'ne', edges:{n:true, e:true} },
    { cls:'w',  edges:{w:true} },                                       { cls:'e',  edges:{e:true} },
    { cls:'sw', edges:{s:true, w:true} }, { cls:'s', edges:{s:true} }, { cls:'se', edges:{s:true, e:true} }
  ];
  handleConfigs.forEach(cfg => {
    const h = document.createElement('div');
    h.className = 'canvas-resize-handle canvas-resize-handle-' + cfg.cls;
    div.appendChild(h);
    makeCanvasElResizable(h, div, el.id, cfg.edges);
  });

  makeCanvasElDraggable(div, el.id);
  return div;
}

function renderCanvasEditor(data){
  const surface = document.getElementById('canvasEditorSurface');
  surface.style.width = data.width + 'px';
  surface.style.height = data.height + 'px';
  surface.innerHTML = '';
  data.elements.forEach(el => surface.appendChild(buildCanvasElementDom(el)));
  updateCanvasUndoRedoButtons();
  updateCanvasTextToolbarState();
}

function addCanvasImageElement(data, id, width, height){
  let w = width || 200, h = height || 150;
  const maxW = Math.min(data.width - 40, 400);
  if(w > maxW && w > 0){ h = h * (maxW / w); w = maxW; }
  const count = data.elements.length;
  data.elements.push({
    id: newElementId(), type:'image',
    x: 20 + (count % 5) * 20, y: 20 + (count % 5) * 20,
    width: Math.round(w), height: Math.round(h), src: 'img://' + id
  });
  return data;
}

document.getElementById('canvasAddTextBtn').addEventListener('click', () => {
  const data = getCurrentCanvasData();
  const count = data.elements.length;
  const id = newElementId();
  data.elements.push({ id, type:'text', x:20 + (count % 5) * 20, y:20 + (count % 5) * 20, width:220, height:70, text:'Text' });
  saveCanvasData(data);
  selectedCanvasElementIds = new Set([id]);
  renderCanvasEditor(data);
});

document.getElementById('canvasAddImageBtn').addEventListener('click', () => {
  document.getElementById('canvasImageInput').click();
});
document.getElementById('canvasImageInput').addEventListener('change', async () => {
  const input = document.getElementById('canvasImageInput');
  const file = input.files && input.files[0];
  input.value = '';
  if(!file || !isImageFile(file)) return;
  try{
    const { id, width, height } = await storeImageBlobFromFile(file);
    const data = addCanvasImageElement(getCurrentCanvasData(), id, width, height);
    saveCanvasData(data);
    renderCanvasEditor(data);
  }catch(e){ console.error(e); }
});

// Paste/drop images directly onto the canvas surface - gated on the
// active column actually being a canvas, since this is a document-level
// listener (the canvas surface isn't a native text input the way the
// markdown textarea is, so paste has to be caught at a higher level) and
// must not steal paste events meant for the markdown editor.
document.addEventListener('paste', (e) => {
  if(getColumnType(columns[activeCol]) !== 'canvas') return;
  const items = (e.clipboardData || window.clipboardData).items;
  const imageFiles = [];
  for(const item of items){
    if(item.type && item.type.startsWith('image/')) imageFiles.push(item.getAsFile());
  }
  if(!imageFiles.length) return;
  e.preventDefault();
  imageFiles.forEach(async (file) => {
    try{
      const { id, width, height } = await storeImageBlobFromFile(file);
      const data = addCanvasImageElement(getCurrentCanvasData(), id, width, height);
      saveCanvasData(data);
      renderCanvasEditor(data);
    }catch(err){ console.error(err); }
  });
});
document.getElementById('canvasEditorSurface').addEventListener('dragover', (e) => e.preventDefault());
document.getElementById('canvasEditorSurface').addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files;
  if(!files || !files.length) return;
  for(const file of Array.from(files)){
    if(!isImageFile(file)) continue;
    try{
      const { id, width, height } = await storeImageBlobFromFile(file);
      const data = addCanvasImageElement(getCurrentCanvasData(), id, width, height);
      saveCanvasData(data);
      renderCanvasEditor(data);
    }catch(err){ console.error(err); }
  }
});

function applyCanvasSpaceDirection(direction){
  const amount = parseFloat(document.getElementById('canvasSpaceAmount').value);
  if(!(amount > 0)) return;
  const data = addCanvasSpace(getCurrentCanvasData(), direction, amount);
  saveCanvasData(data);
  renderCanvasEditor(data);
}
document.getElementById('canvasSpaceLeftBtn').addEventListener('click', () => applyCanvasSpaceDirection('left'));
document.getElementById('canvasSpaceRightBtn').addEventListener('click', () => applyCanvasSpaceDirection('right'));
document.getElementById('canvasSpaceTopBtn').addEventListener('click', () => applyCanvasSpaceDirection('top'));
document.getElementById('canvasSpaceBottomBtn').addEventListener('click', () => applyCanvasSpaceDirection('bottom'));

// ---- Text box formatting toolbar: bold/italic/font-size act on every
// currently-selected TEXT element (image elements in the selection are
// silently skipped, not an error).
document.getElementById('canvasTextBoldBtn').addEventListener('click', () => {
  const data = getCurrentCanvasData();
  const ids = selectedTextElementIds(data);
  if(ids.length === 0) return;
  const next = toggleCanvasTextFormat(data, ids, 'bold');
  saveCanvasData(next);
  renderCanvasEditor(next);
});
document.getElementById('canvasTextItalicBtn').addEventListener('click', () => {
  const data = getCurrentCanvasData();
  const ids = selectedTextElementIds(data);
  if(ids.length === 0) return;
  const next = toggleCanvasTextFormat(data, ids, 'italic');
  saveCanvasData(next);
  renderCanvasEditor(next);
});
document.getElementById('canvasFontSizeSelect').addEventListener('change', () => {
  const data = getCurrentCanvasData();
  const ids = selectedTextElementIds(data);
  if(ids.length === 0) return;
  const size = parseInt(document.getElementById('canvasFontSizeSelect').value, 10);
  const next = applyCanvasTextFormat(data, ids, 'fontSize', size);
  saveCanvasData(next);
  renderCanvasEditor(next);
});

// ---- Multi-select rubber-band: mousedown on empty canvas surface (not
// on any element) starts a drag rectangle; elementsIntersectingRect()
// (pure, tested separately) decides what ends up selected on mouseup.
document.getElementById('canvasEditorSurface').addEventListener('mousedown', (e) => {
  if(e.target.closest('.canvas-el')) return;
  const surface = document.getElementById('canvasEditorSurface');
  const surfaceRect = surface.getBoundingClientRect();
  const startX = e.clientX - surfaceRect.left, startY = e.clientY - surfaceRect.top;
  if(!e.shiftKey) clearCanvasSelection();
  const box = document.createElement('div');
  box.className = 'canvas-select-box';
  surface.appendChild(box);
  function onMove(ev){
    const r = surface.getBoundingClientRect();
    const curX = ev.clientX - r.left, curY = ev.clientY - r.top;
    box.style.left = Math.min(startX, curX) + 'px';
    box.style.top = Math.min(startY, curY) + 'px';
    box.style.width = Math.abs(curX - startX) + 'px';
    box.style.height = Math.abs(curY - startY) + 'px';
  }
  function onUp(ev){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const r = surface.getBoundingClientRect();
    const curX = ev.clientX - r.left, curY = ev.clientY - r.top;
    const data = getCurrentCanvasData();
    const hitIds = elementsIntersectingRect(data.elements, { x0:startX, y0:startY, x1:curX, y1:curY });
    hitIds.forEach(id => selectedCanvasElementIds.add(id));
    refreshCanvasSelectionHighlight();
    box.remove();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ---- Toolbar: align/distribute, acting on the current selection.
function applyCanvasAlign(mode){
  if(selectedCanvasElementIds.size < 2) return;
  const data = alignElements(getCurrentCanvasData(), Array.from(selectedCanvasElementIds), mode);
  saveCanvasData(data);
  renderCanvasEditor(data);
}
document.getElementById('canvasAlignLeftBtn').addEventListener('click', () => applyCanvasAlign('left'));
document.getElementById('canvasAlignHCenterBtn').addEventListener('click', () => applyCanvasAlign('hcenter'));
document.getElementById('canvasAlignRightBtn').addEventListener('click', () => applyCanvasAlign('right'));
document.getElementById('canvasAlignTopBtn').addEventListener('click', () => applyCanvasAlign('top'));
document.getElementById('canvasAlignVCenterBtn').addEventListener('click', () => applyCanvasAlign('vcenter'));
document.getElementById('canvasAlignBottomBtn').addEventListener('click', () => applyCanvasAlign('bottom'));
document.getElementById('canvasDistributeHBtn').addEventListener('click', () => {
  if(selectedCanvasElementIds.size < 3) return;
  const data = distributeElements(getCurrentCanvasData(), Array.from(selectedCanvasElementIds), 'horizontal');
  saveCanvasData(data);
  renderCanvasEditor(data);
});
document.getElementById('canvasDistributeVBtn').addEventListener('click', () => {
  if(selectedCanvasElementIds.size < 3) return;
  const data = distributeElements(getCurrentCanvasData(), Array.from(selectedCanvasElementIds), 'vertical');
  saveCanvasData(data);
  renderCanvasEditor(data);
});

// ---- Toolbar: duplicate, layer ordering, undo/redo.
document.getElementById('canvasDuplicateBtn').addEventListener('click', () => {
  if(selectedCanvasElementIds.size === 0) return;
  const { data, newIds } = duplicateCanvasElements(getCurrentCanvasData(), Array.from(selectedCanvasElementIds));
  saveCanvasData(data);
  selectedCanvasElementIds = new Set(newIds);
  renderCanvasEditor(data);
});
document.getElementById('canvasBringFrontBtn').addEventListener('click', () => {
  let data = getCurrentCanvasData();
  selectedCanvasElementIds.forEach(id => { data = bringElementToFront(data, id); });
  saveCanvasData(data);
  renderCanvasEditor(data);
});
document.getElementById('canvasSendBackBtn').addEventListener('click', () => {
  let data = getCurrentCanvasData();
  Array.from(selectedCanvasElementIds).reverse().forEach(id => { data = sendElementToBack(data, id); });
  saveCanvasData(data);
  renderCanvasEditor(data);
});
document.getElementById('canvasForwardBtn').addEventListener('click', () => {
  let data = getCurrentCanvasData();
  selectedCanvasElementIds.forEach(id => { data = bringElementForward(data, id); });
  saveCanvasData(data);
  renderCanvasEditor(data);
});
document.getElementById('canvasBackwardBtn').addEventListener('click', () => {
  let data = getCurrentCanvasData();
  selectedCanvasElementIds.forEach(id => { data = sendElementBackward(data, id); });
  saveCanvasData(data);
  renderCanvasEditor(data);
});
document.getElementById('canvasUndoBtn').addEventListener('click', canvasUndo);
document.getElementById('canvasRedoBtn').addEventListener('click', canvasRedo);

// ---- Keyboard: Delete (selected elements), Ctrl+D (duplicate), Ctrl+Z
// (undo), Ctrl+Shift+Z / Ctrl+Y (redo). All gated on the active column
// actually being a canvas, and on focus NOT being inside a text box's
// own textarea - typing inside a text box has its own native undo/
// delete-character behavior, which this must not intercept or override.
const CANVAS_ARROW_KEYS = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
document.addEventListener('keydown', (e) => {
  if(getColumnType(columns[activeCol]) !== 'canvas') return;
  const activeIsCanvasTextarea = document.activeElement
    && document.activeElement.tagName === 'TEXTAREA'
    && document.activeElement.closest('#canvasEditorSurface');
  if(activeIsCanvasTextarea) return;

  if((e.key === 'Delete' || e.key === 'Backspace') && selectedCanvasElementIds.size > 0){
    e.preventDefault();
    deleteSelectedCanvasElements();
    return;
  }
  if(CANVAS_ARROW_KEYS[e.key] && selectedCanvasElementIds.size > 0){
    e.preventDefault();
    const [dx, dy] = CANVAS_ARROW_KEYS[e.key];
    const amount = e.shiftKey ? 10 : 1;
    const data = nudgeElements(getCurrentCanvasData(), selectedCanvasElementIds, dx * amount, dy * amount);
    // e.repeat is true for OS-auto-repeated keydowns from a held key -
    // only the FIRST press of a nudge gesture gets its own undo
    // checkpoint, so holding an arrow key doesn't flood the undo stack
    // with one entry per repeat tick (same reasoning as why typing
    // inside a text box doesn't push a snapshot per keystroke).
    if(e.repeat) saveCanvasDataQuiet(data); else saveCanvasData(data);
    renderCanvasEditor(data);
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if(!mod) return;
  const key = e.key.toLowerCase();
  if(key === 'd'){
    e.preventDefault();
    document.getElementById('canvasDuplicateBtn').click();
  } else if(key === 'z' && !e.shiftKey){
    e.preventDefault();
    canvasUndo();
  } else if((key === 'z' && e.shiftKey) || key === 'y'){
    e.preventDefault();
    canvasRedo();
  }
});
