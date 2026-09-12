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

// ---- Static (non-interactive) rendering for the preview pane / PDF
// export - reuses resolveImages() (via the img://<id> src convention)
// exactly like markdown images do, so canvas images get the same
// lossless-storage and "image unavailable" fallback handling for free.
function renderCanvasHTML(data){
  const elementsHtml = data.elements.map(el => {
    const style = `left:${el.x}px;top:${el.y}px;width:${el.width}px;height:${el.height}px;`;
    if(el.type === 'text'){
      return `<div class="canvas-el canvas-el-text" style="${style}">${escapeHtml(el.text || '')}</div>`;
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
   images anywhere, plus the "add space" tool that grows the canvas in a
   given direction. All persistence goes through saveCanvasData(), which
   serializes back into columns[activeCol] via the same string-based
   representation the static preview renderer reads - there is no
   separate "live" in-memory canvas state that could drift from what's
   actually saved.
   ========================================================================= */
function getCurrentCanvasData(){
  return parseCanvasData(columns[activeCol] || '');
}
function saveCanvasData(data){
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

function makeCanvasElDraggable(div, elId){
  div.addEventListener('mousedown', (e) => {
    if(e.target.closest('.canvas-resize-handle') || e.target.closest('.canvas-el-delete') || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const origLeft = parseFloat(div.style.left) || 0;
    const origTop = parseFloat(div.style.top) || 0;
    function onMove(ev){
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      div.style.left = Math.max(0, origLeft + dx) + 'px';
      div.style.top = Math.max(0, origTop + dy) + 'px';
    }
    function onUp(){
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const data = getCurrentCanvasData();
      const target = data.elements.find(x => x.id === elId);
      if(target){
        target.x = parseFloat(div.style.left) || 0;
        target.y = parseFloat(div.style.top) || 0;
      }
      saveCanvasData(data);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
function makeCanvasElResizable(handle, div, elId){
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origWidth = parseFloat(div.style.width) || 100;
    const origHeight = parseFloat(div.style.height) || 60;
    function onMove(ev){
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      div.style.width = Math.max(20, origWidth + dx) + 'px';
      div.style.height = Math.max(20, origHeight + dy) + 'px';
    }
    function onUp(){
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const data = getCurrentCanvasData();
      const target = data.elements.find(x => x.id === elId);
      if(target){
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
  div.dataset.id = el.id;
  div.style.left = el.x + 'px';
  div.style.top = el.y + 'px';
  div.style.width = el.width + 'px';
  div.style.height = el.height + 'px';

  if(el.type === 'text'){
    const ta = document.createElement('textarea');
    ta.value = el.text || '';
    ta.addEventListener('mousedown', (e) => e.stopPropagation());
    ta.addEventListener('input', () => {
      const data = getCurrentCanvasData();
      const target = data.elements.find(x => x.id === el.id);
      if(target) target.text = ta.value;
      saveCanvasData(data);
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
    saveCanvasData(data);
    renderCanvasEditor(data);
  });
  div.appendChild(del);

  const handle = document.createElement('div');
  handle.className = 'canvas-resize-handle';
  div.appendChild(handle);

  makeCanvasElDraggable(div, el.id);
  makeCanvasElResizable(handle, div, el.id);
  return div;
}

function renderCanvasEditor(data){
  const surface = document.getElementById('canvasEditorSurface');
  surface.style.width = data.width + 'px';
  surface.style.height = data.height + 'px';
  surface.innerHTML = '';
  data.elements.forEach(el => surface.appendChild(buildCanvasElementDom(el)));
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
  data.elements.push({ id:newElementId(), type:'text', x:20 + (count % 5) * 20, y:20 + (count % 5) * 20, width:220, height:70, text:'Text' });
  saveCanvasData(data);
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
