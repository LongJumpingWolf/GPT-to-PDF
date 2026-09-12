/* =============================================================================
   sheet.js — the spreadsheet column type.

   Loaded after columns.js (uses SHEET_MARKER/escapeHtml) and before
   index.html's own script, which defines the shared app state
   (columns/activeCol/render/statusEl) the interactive editor references -
   safe per the cross-file convention used throughout this app.

   Scope, stated plainly: text/number cells only. No formulas, no cell
   formatting, no merged cells, no resizable row/column dimensions. What
   IS here: range selection, arrow/Tab/Enter keyboard navigation,
   insert/delete a row or column at any position (not just the end),
   row-number/column-letter headers, and copy/paste that round-trips
   with both real spreadsheet apps (TSV, what Excel/Sheets put on the
   clipboard) and Markdown tables (this app's native format).
   ============================================================================= */

function parseSheetData(text){
  try{
    const json = (text || '').slice(SHEET_MARKER.length).replace(/^\n/, '');
    const data = JSON.parse(json);
    return {
      rows: (typeof data.rows === 'number' && data.rows > 0) ? data.rows : 6,
      cols: (typeof data.cols === 'number' && data.cols > 0) ? data.cols : 4,
      cells: (data.cells && typeof data.cells === 'object') ? data.cells : {}
    };
  }catch(e){
    return { rows:6, cols:4, cells:{} };
  }
}
function serializeSheetData(data){
  return SHEET_MARKER + '\n' + JSON.stringify({ rows:data.rows, cols:data.cols, cells:data.cells });
}
function defaultSheetText(){
  return serializeSheetData({ rows:6, cols:4, cells:{} });
}

function renderSheetHTML(data){
  let rows = '';
  for(let r = 0; r < data.rows; r++){
    let cells = '';
    for(let c = 0; c < data.cols; c++){
      const val = data.cells[r + ',' + c] || '';
      cells += `<td>${escapeHtml(val)}</td>`;
    }
    rows += `<tr>${cells}</tr>`;
  }
  return `<table class="sheet-page">${rows}</table>`;
}

// ---- Pure data-transform functions - these are the parts most worth
// testing rigorously, since a re-keying mistake here would silently
// misplace or destroy cell data rather than throw an error. ----

// "Add at end" - used by the toolbar's simple +Row/+Col/-Row/-Col
// buttons. No re-keying needed since nothing before the end shifts.
function addSheetRow(data){
  return { rows: data.rows + 1, cols: data.cols, cells: Object.assign({}, data.cells) };
}
function addSheetCol(data){
  return { rows: data.rows, cols: data.cols + 1, cells: Object.assign({}, data.cells) };
}
function removeSheetRow(data){
  if(data.rows <= 1) return data;
  const newRows = data.rows - 1;
  const cells = {};
  Object.keys(data.cells).forEach(key => {
    const r = parseInt(key.split(',')[0], 10);
    if(r < newRows) cells[key] = data.cells[key];
  });
  return { rows:newRows, cols:data.cols, cells };
}
function removeSheetCol(data){
  if(data.cols <= 1) return data;
  const newCols = data.cols - 1;
  const cells = {};
  Object.keys(data.cells).forEach(key => {
    const c = parseInt(key.split(',')[1], 10);
    if(c < newCols) cells[key] = data.cells[key];
  });
  return { rows:data.rows, cols:newCols, cells };
}

// "Insert/delete AT a position" - used by the row/column header context
// menu. Unlike the end-only functions above, these DO need to re-key
// every cell at or past the affected index, since inserting/deleting in
// the middle shifts every subsequent row/column's index by one.
function insertSheetRowAt(data, atIndex){
  const idx = Math.max(0, Math.min(atIndex, data.rows));
  const cells = {};
  Object.keys(data.cells).forEach(key => {
    const parts = key.split(',').map(Number);
    const r = parts[0], c = parts[1];
    const newR = r >= idx ? r + 1 : r;
    cells[newR + ',' + c] = data.cells[key];
  });
  return { rows: data.rows + 1, cols: data.cols, cells };
}
function insertSheetColAt(data, atIndex){
  const idx = Math.max(0, Math.min(atIndex, data.cols));
  const cells = {};
  Object.keys(data.cells).forEach(key => {
    const parts = key.split(',').map(Number);
    const r = parts[0], c = parts[1];
    const newC = c >= idx ? c + 1 : c;
    cells[r + ',' + newC] = data.cells[key];
  });
  return { rows: data.rows, cols: data.cols + 1, cells };
}
function deleteSheetRowAt(data, atIndex){
  if(data.rows <= 1) return data;
  const cells = {};
  Object.keys(data.cells).forEach(key => {
    const parts = key.split(',').map(Number);
    const r = parts[0], c = parts[1];
    if(r === atIndex) return; // dropped along with the row
    const newR = r > atIndex ? r - 1 : r;
    cells[newR + ',' + c] = data.cells[key];
  });
  return { rows: data.rows - 1, cols: data.cols, cells };
}
function deleteSheetColAt(data, atIndex){
  if(data.cols <= 1) return data;
  const cells = {};
  Object.keys(data.cells).forEach(key => {
    const parts = key.split(',').map(Number);
    const r = parts[0], c = parts[1];
    if(c === atIndex) return;
    const newC = c > atIndex ? c - 1 : c;
    cells[r + ',' + newC] = data.cells[key];
  });
  return { rows: data.rows, cols: data.cols - 1, cells };
}

// ---- Markdown table / TSV interchange - also pure functions. ----

// A pasted block is treated as a Markdown table only if it has pipe
// delimiters AND a valid "---" separator row as its second line -
// otherwise it's treated as plain delimited text (TSV, what real
// spreadsheet apps put on the clipboard).
function parseMarkdownTable(text){
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tableLines = lines.filter(l => l.includes('|'));
  if(tableLines.length < 2) return null;
  const sepLine = tableLines[1];
  const isSeparator = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(sepLine);
  if(!isSeparator) return null;

  const parseRow = (line) => {
    let l = line.trim();
    if(l.startsWith('|')) l = l.slice(1);
    if(l.endsWith('|')) l = l.slice(0, -1);
    return l.split('|').map(cell => cell.trim());
  };

  const dataLines = [tableLines[0]].concat(tableLines.slice(2));
  const parsedRows = dataLines.map(parseRow);
  const cols = Math.max.apply(null, parsedRows.map(r => r.length));
  const cells = {};
  parsedRows.forEach((row, r) => {
    row.forEach((val, c) => { if(val) cells[r + ',' + c] = val; });
  });
  return { rows: parsedRows.length, cols, cells };
}
function parseDelimitedText(text){
  const normalized = text.replace(/\r\n/g, '\n');
  let lines = normalized.split('\n');
  if(lines.length > 1 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  if(lines.length === 0) return null;
  const parsedRows = lines.map(line => line.split('\t'));
  const cols = Math.max.apply(null, parsedRows.map(r => r.length));
  const cells = {};
  parsedRows.forEach((row, r) => {
    row.forEach((val, c) => { if(val) cells[r + ',' + c] = val; });
  });
  return { rows: parsedRows.length, cols, cells };
}
function parsePastedTableText(text){
  if(!text) return null;
  const md = parseMarkdownTable(text);
  if(md) return md;
  return parseDelimitedText(text);
}

// Formats data (or a sub-range { r0,c0,r1,c1 }) as a Markdown table string.
function sheetToMarkdownTable(data, range){
  const r0 = range ? range.r0 : 0, r1 = range ? range.r1 : data.rows - 1;
  const c0 = range ? range.c0 : 0, c1 = range ? range.c1 : data.cols - 1;
  const lines = [];
  for(let r = r0; r <= r1; r++){
    const rowCells = [];
    for(let c = c0; c <= c1; c++){
      rowCells.push((data.cells[r + ',' + c] || '').replace(/\|/g, '\\|'));
    }
    lines.push('| ' + rowCells.join(' | ') + ' |');
    if(r === r0){
      lines.push('|' + rowCells.map(() => ' --- ').join('|') + '|');
    }
  }
  return lines.join('\n');
}
// Formats a sub-range as plain TSV - matches what Excel/Sheets themselves
// put on the clipboard, so copying from here and pasting into a real
// spreadsheet app (or vice versa) round-trips correctly.
function sheetToTSV(data, range){
  const r0 = range ? range.r0 : 0, r1 = range ? range.r1 : data.rows - 1;
  const c0 = range ? range.c0 : 0, c1 = range ? range.c1 : data.cols - 1;
  const lines = [];
  for(let r = r0; r <= r1; r++){
    const rowCells = [];
    for(let c = c0; c <= c1; c++) rowCells.push(data.cells[r + ',' + c] || '');
    lines.push(rowCells.join('\t'));
  }
  return lines.join('\n');
}
// Pastes parsed table data into `data` starting at (startR, startC),
// growing rows/cols if the pasted block runs past the current grid size.
function pasteIntoSheet(data, parsed, startR, startC){
  let rows = data.rows, cols = data.cols;
  const cells = Object.assign({}, data.cells);
  for(let r = 0; r < parsed.rows; r++){
    for(let c = 0; c < parsed.cols; c++){
      const val = parsed.cells[r + ',' + c];
      if(val === undefined) continue;
      const targetR = startR + r, targetC = startC + c;
      cells[targetR + ',' + targetC] = val;
      if(targetR + 1 > rows) rows = targetR + 1;
      if(targetC + 1 > cols) cols = targetC + 1;
    }
  }
  return { rows, cols, cells };
}

// Spreadsheet-style column letters: 0->A, 1->B, ..., 25->Z, 26->AA, ...
function colLetter(c){
  let s = '';
  let n = c + 1;
  while(n > 0){
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* =========================================================================
   Spreadsheet interactive editor.
   ========================================================================= */
function getCurrentSheetData(){
  return parseSheetData(columns[activeCol] || '');
}
function saveSheetData(data){
  columns[activeCol] = serializeSheetData(data);
  render();
}

let sheetSelection = null;   // { r0, c0, r1, c1 } - rectangular, r0<=r1, c0<=c1
let sheetActiveCell = null;  // { r, c } - paste target / keyboard nav anchor
let sheetDragAnchor = null;  // set on mousedown, used while drag-selecting

function isCellSelected(r, c){
  if(!sheetSelection) return false;
  return r >= sheetSelection.r0 && r <= sheetSelection.r1 && c >= sheetSelection.c0 && c <= sheetSelection.c1;
}
function setSheetSelection(r0, c0, r1, c1){
  sheetSelection = { r0:Math.min(r0,r1), c0:Math.min(c0,c1), r1:Math.max(r0,r1), c1:Math.max(c0,c1) };
  sheetActiveCell = { r:r0, c:c0 };
}
// Lighter than a full renderSheetEditor() during drag-select - only
// toggles highlight classes, so it doesn't rebuild inputs mid-drag
// (which would steal focus and abort the drag).
function refreshSheetSelectionHighlight(){
  const table = document.getElementById('sheetEditorTable');
  Array.from(table.querySelectorAll('input')).forEach(input => {
    const r = +input.dataset.row, c = +input.dataset.col;
    input.parentElement.classList.toggle('sheet-cell-selected', isCellSelected(r, c));
  });
}

function focusSheetCell(r, c, data){
  r = Math.max(0, Math.min(r, data.rows - 1));
  c = Math.max(0, Math.min(c, data.cols - 1));
  const input = document.querySelector('#sheetEditorTable input[data-row="' + r + '"][data-col="' + c + '"]');
  if(input){ input.focus(); input.select(); }
}

async function copySheetSelectionToClipboard(){
  if(!sheetSelection || !navigator.clipboard || !navigator.clipboard.writeText) return;
  const data = getCurrentSheetData();
  const tsv = sheetToTSV(data, sheetSelection);
  try{ await navigator.clipboard.writeText(tsv); }catch(e){ /* clipboard permission denied - non-fatal */ }
}

function clearSheetSelection(){
  if(!sheetSelection) return;
  const data = getCurrentSheetData();
  for(let r = sheetSelection.r0; r <= sheetSelection.r1; r++){
    for(let c = sheetSelection.c0; c <= sheetSelection.c1; c++){
      delete data.cells[r + ',' + c];
    }
  }
  saveSheetData(data);
  renderSheetEditor(data);
}

function handleSheetCellKeydown(e, r, c, data){
  const mod = e.ctrlKey || e.metaKey;
  if(mod && e.key.toLowerCase() === 'c'){ e.preventDefault(); copySheetSelectionToClipboard(); return; }
  if(e.key === 'Delete' || (e.key === 'Backspace' && sheetSelection && (sheetSelection.r0 !== sheetSelection.r1 || sheetSelection.c0 !== sheetSelection.c1))){
    e.preventDefault();
    clearSheetSelection();
    return;
  }
  if(e.key === 'ArrowDown'){ e.preventDefault(); focusSheetCell(r+1, c, data); }
  else if(e.key === 'ArrowUp'){ e.preventDefault(); focusSheetCell(r-1, c, data); }
  else if(e.key === 'ArrowLeft'){ e.preventDefault(); focusSheetCell(r, c-1, data); }
  else if(e.key === 'ArrowRight'){ e.preventDefault(); focusSheetCell(r, c+1, data); }
  else if(e.key === 'Tab'){ e.preventDefault(); focusSheetCell(r, e.shiftKey ? c-1 : c+1, data); }
  else if(e.key === 'Enter'){ e.preventDefault(); focusSheetCell(r+1, c, data); }
}

function renderSheetEditor(data){
  const table = document.getElementById('sheetEditorTable');
  table.innerHTML = '';

  const headerRow = document.createElement('tr');
  headerRow.appendChild(document.createElement('th')); // blank corner cell
  for(let c = 0; c < data.cols; c++){
    const th = document.createElement('th');
    th.textContent = colLetter(c);
    th.className = 'sheet-col-header';
    th.addEventListener('click', () => { setSheetSelection(0, c, data.rows - 1, c); renderSheetEditor(data); });
    th.addEventListener('contextmenu', (e) => { e.preventDefault(); showSheetHeaderMenu(e.clientX, e.clientY, 'col', c); });
    headerRow.appendChild(th);
  }
  table.appendChild(headerRow);

  for(let r = 0; r < data.rows; r++){
    const tr = document.createElement('tr');
    const rowHeader = document.createElement('th');
    rowHeader.textContent = String(r + 1);
    rowHeader.className = 'sheet-row-header';
    rowHeader.addEventListener('click', () => { setSheetSelection(r, 0, r, data.cols - 1); renderSheetEditor(data); });
    rowHeader.addEventListener('contextmenu', (e) => { e.preventDefault(); showSheetHeaderMenu(e.clientX, e.clientY, 'row', r); });
    tr.appendChild(rowHeader);

    for(let c = 0; c < data.cols; c++){
      const td = document.createElement('td');
      if(isCellSelected(r, c)) td.classList.add('sheet-cell-selected');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = data.cells[r + ',' + c] || '';
      input.dataset.row = String(r);
      input.dataset.col = String(c);

      input.addEventListener('mousedown', () => {
        sheetDragAnchor = { r, c };
        setSheetSelection(r, c, r, c);
        refreshSheetSelectionHighlight();
      });
      input.addEventListener('mouseenter', (e) => {
        if(sheetDragAnchor && e.buttons === 1){
          setSheetSelection(sheetDragAnchor.r, sheetDragAnchor.c, r, c);
          refreshSheetSelectionHighlight();
        }
      });
      input.addEventListener('focus', () => {
        sheetActiveCell = { r, c };
        if(!sheetSelection || !isCellSelected(r, c)){
          setSheetSelection(r, c, r, c);
          refreshSheetSelectionHighlight();
        }
      });
      input.addEventListener('input', () => {
        const d2 = getCurrentSheetData();
        const key = r + ',' + c;
        if(input.value){ d2.cells[key] = input.value; } else { delete d2.cells[key]; }
        saveSheetData(d2);
      });
      input.addEventListener('keydown', (e) => handleSheetCellKeydown(e, r, c, data));

      td.appendChild(input);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
}
document.addEventListener('mouseup', () => { sheetDragAnchor = null; });

document.getElementById('sheetAddRowBtn').addEventListener('click', () => {
  const data = addSheetRow(getCurrentSheetData());
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetAddColBtn').addEventListener('click', () => {
  const data = addSheetCol(getCurrentSheetData());
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetDelRowBtn').addEventListener('click', () => {
  const data = removeSheetRow(getCurrentSheetData());
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetDelColBtn').addEventListener('click', () => {
  const data = removeSheetCol(getCurrentSheetData());
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetCopyMarkdownBtn').addEventListener('click', async () => {
  if(!sheetSelection || !navigator.clipboard || !navigator.clipboard.writeText) return;
  const data = getCurrentSheetData();
  const md = sheetToMarkdownTable(data, sheetSelection);
  try{
    await navigator.clipboard.writeText(md);
    const prev = statusEl.textContent;
    statusEl.textContent = 'copied as Markdown table';
    setTimeout(() => { statusEl.textContent = prev; }, 1500);
  }catch(e){ /* non-fatal */ }
});

// Row/column header right-click menu: insert before/after, or delete.
let sheetHeaderMenuContext = null;
function showSheetHeaderMenu(x, y, kind, index){
  sheetHeaderMenuContext = { kind, index };
  const menu = document.getElementById('sheetHeaderMenu');
  document.getElementById('sheetHeaderInsertBefore').textContent = kind === 'row' ? 'Insert row above' : 'Insert column before';
  document.getElementById('sheetHeaderInsertAfter').textContent = kind === 'row' ? 'Insert row below' : 'Insert column after';
  document.getElementById('sheetHeaderDelete').textContent = kind === 'row' ? 'Delete row' : 'Delete column';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';
}
function hideSheetHeaderMenu(){
  document.getElementById('sheetHeaderMenu').style.display = 'none';
  sheetHeaderMenuContext = null;
}
document.getElementById('sheetHeaderInsertBefore').addEventListener('click', () => {
  if(!sheetHeaderMenuContext) return;
  const { kind, index } = sheetHeaderMenuContext;
  const data = kind === 'row' ? insertSheetRowAt(getCurrentSheetData(), index) : insertSheetColAt(getCurrentSheetData(), index);
  saveSheetData(data);
  renderSheetEditor(data);
  hideSheetHeaderMenu();
});
document.getElementById('sheetHeaderInsertAfter').addEventListener('click', () => {
  if(!sheetHeaderMenuContext) return;
  const { kind, index } = sheetHeaderMenuContext;
  const data = kind === 'row' ? insertSheetRowAt(getCurrentSheetData(), index + 1) : insertSheetColAt(getCurrentSheetData(), index + 1);
  saveSheetData(data);
  renderSheetEditor(data);
  hideSheetHeaderMenu();
});
document.getElementById('sheetHeaderDelete').addEventListener('click', () => {
  if(!sheetHeaderMenuContext) return;
  const { kind, index } = sheetHeaderMenuContext;
  const data = kind === 'row' ? deleteSheetRowAt(getCurrentSheetData(), index) : deleteSheetColAt(getCurrentSheetData(), index);
  saveSheetData(data);
  renderSheetEditor(data);
  hideSheetHeaderMenu();
});
document.addEventListener('click', (e) => {
  const menu = document.getElementById('sheetHeaderMenu');
  if(menu.style.display === 'block' && !menu.contains(e.target)) hideSheetHeaderMenu();
});

// Paste - gated on the active column actually being a sheet, since this
// is a document-level listener (canvas.js has its own equivalent, gated
// on canvas instead - only one of the two ever actually acts on a given
// paste, since a column can't be both types at once). Tries Markdown
// table syntax first, falls back to TSV (real spreadsheet apps' native
// clipboard format).
document.addEventListener('paste', (e) => {
  if(getColumnType(columns[activeCol]) !== 'sheet') return;
  if(!sheetActiveCell) return;
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  const parsed = parsePastedTableText(text);
  if(!parsed) return;
  e.preventDefault();
  const data = pasteIntoSheet(getCurrentSheetData(), parsed, sheetActiveCell.r, sheetActiveCell.c);
  saveSheetData(data);
  renderSheetEditor(data);
});
