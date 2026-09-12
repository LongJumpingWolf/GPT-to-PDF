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

const DEFAULT_COL_WIDTH = 90;
const DEFAULT_ROW_HEIGHT = 28;

function parseSheetData(text){
  try{
    const json = (text || '').slice(SHEET_MARKER.length).replace(/^\n/, '');
    const data = JSON.parse(json);
    return {
      rows: (typeof data.rows === 'number' && data.rows > 0) ? data.rows : 6,
      cols: (typeof data.cols === 'number' && data.cols > 0) ? data.cols : 4,
      cells: (data.cells && typeof data.cells === 'object') ? data.cells : {},
      formats: (data.formats && typeof data.formats === 'object') ? data.formats : {},
      colWidths: (data.colWidths && typeof data.colWidths === 'object') ? data.colWidths : {},
      rowHeights: (data.rowHeights && typeof data.rowHeights === 'object') ? data.rowHeights : {},
      merges: Array.isArray(data.merges) ? data.merges : [],
      freeze: !!data.freeze
    };
  }catch(e){
    return { rows:6, cols:4, cells:{}, formats:{}, colWidths:{}, rowHeights:{}, merges:[], freeze:false };
  }
}
function serializeSheetData(data){
  return SHEET_MARKER + '\n' + JSON.stringify({
    rows:data.rows, cols:data.cols, cells:data.cells, formats:data.formats || {},
    colWidths:data.colWidths || {}, rowHeights:data.rowHeights || {},
    merges:data.merges || [], freeze:!!data.freeze
  });
}
function defaultSheetText(){
  return serializeSheetData({ rows:6, cols:4, cells:{}, formats:{}, colWidths:{}, rowHeights:{}, merges:[], freeze:false });
}

function renderSheetHTML(data){
  let rows = '';
  for(let r = 0; r < data.rows; r++){
    let cells = '';
    for(let c = 0; c < data.cols; c++){
      const span = cellSpanInfo(data.merges, r, c);
      if(span.skip) continue; // covered by another cell's rowspan/colspan - no <td> of its own
      const val = data.cells[r + ',' + c] || '';
      const styleAttr = sheetCellStyleAttr((data.formats || {})[r + ',' + c]);
      const spanAttrs = (span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : '') + (span.colspan > 1 ? ` colspan="${span.colspan}"` : '');
      cells += `<td${spanAttrs}${styleAttr}>${escapeHtml(val)}</td>`;
    }
    const heightAttr = (data.rowHeights && data.rowHeights[r]) ? ` style="height:${data.rowHeights[r]}px;"` : '';
    rows += `<tr${heightAttr}>${cells}</tr>`;
  }
  return `<table class="sheet-page">${rows}</table>`;
}

// ---- Pure data-transform functions - these are the parts most worth
// testing rigorously, since a re-keying mistake here would silently
// misplace or destroy cell data rather than throw an error. ----

// Shared re-keying logic for cells AND formats - both are keyed "r,c",
// so both need identical re-keying whenever rows/cols shift. Doing this
// once here (rather than duplicating the same loop for cells and again
// for formats in every function below) means they can't accidentally
// drift out of sync with each other.
function reKeySheetMap(map, transformFn){
  const result = {};
  Object.keys(map).forEach(key => {
    const parts = key.split(',').map(Number);
    const newKey = transformFn(parts[0], parts[1]);
    if(newKey !== null) result[newKey] = map[key];
  });
  return result;
}
// colWidths/rowHeights are keyed by a plain index (not "r,c"), so they
// need their own 1-dimensional version of the same idea.
function reKeyIndexMap(map, transformFn){
  const result = {};
  Object.keys(map || {}).forEach(key => {
    const newKey = transformFn(Number(key));
    if(newKey !== null) result[newKey] = map[key];
  });
  return result;
}
// Merged-cell ranges need to grow/shrink/shift as a whole rectangle
// rather than being re-keyed cell-by-cell. A merge that a deletion cuts
// down to zero area (or to a single cell, which isn't a meaningful
// "merge" anymore) is dropped entirely rather than left as degenerate
// data that later rendering code would have to guard against.
function adjustMergesForRowInsert(merges, atIndex){
  return (merges || []).map(m => {
    if(atIndex <= m.r0) return { r0:m.r0+1, c0:m.c0, r1:m.r1+1, c1:m.c1 };
    if(atIndex <= m.r1) return { r0:m.r0, c0:m.c0, r1:m.r1+1, c1:m.c1 }; // insertion lands INSIDE the merge - it grows to include the new row
    return m;
  });
}
function adjustMergesForColInsert(merges, atIndex){
  return (merges || []).map(m => {
    if(atIndex <= m.c0) return { r0:m.r0, c0:m.c0+1, r1:m.r1, c1:m.c1+1 };
    if(atIndex <= m.c1) return { r0:m.r0, c0:m.c0, r1:m.r1, c1:m.c1+1 };
    return m;
  });
}
function adjustMergesForRowDelete(merges, atIndex){
  return (merges || []).map(m => {
    let r0 = m.r0, r1 = m.r1;
    if(atIndex < r0){ r0--; r1--; }
    else if(atIndex <= r1){ r1--; }
    return { r0, c0:m.c0, r1, c1:m.c1 };
  }).filter(m => m.r0 <= m.r1 && !(m.r0 === m.r1 && m.c0 === m.c1));
}
function adjustMergesForColDelete(merges, atIndex){
  return (merges || []).map(m => {
    let c0 = m.c0, c1 = m.c1;
    if(atIndex < c0){ c0--; c1--; }
    else if(atIndex <= c1){ c1--; }
    return { r0:m.r0, c0, r1:m.r1, c1 };
  }).filter(m => m.c0 <= m.c1 && !(m.r0 === m.r1 && m.c0 === m.c1));
}

// "Add at end" - used by the toolbar's simple +Row/+Col/-Row/-Col
// buttons. No re-keying needed since nothing before the end shifts, and
// merges/colWidths/rowHeights are all unaffected by growth at the end.
function addSheetRow(data){
  return Object.assign({}, data, { rows: data.rows + 1, cells: Object.assign({}, data.cells), formats: Object.assign({}, data.formats) });
}
function addSheetCol(data){
  return Object.assign({}, data, { cols: data.cols + 1, cells: Object.assign({}, data.cells), formats: Object.assign({}, data.formats) });
}
function removeSheetRow(data){
  if(data.rows <= 1) return data;
  const newRows = data.rows - 1;
  const keep = (r) => r < newRows;
  const cells = reKeySheetMap(data.cells, (r, c) => keep(r) ? (r + ',' + c) : null);
  const formats = reKeySheetMap(data.formats || {}, (r, c) => keep(r) ? (r + ',' + c) : null);
  const rowHeights = reKeyIndexMap(data.rowHeights, (r) => keep(r) ? r : null);
  const merges = adjustMergesForRowDelete(data.merges, newRows);
  return Object.assign({}, data, { rows:newRows, cells, formats, rowHeights, merges });
}
function removeSheetCol(data){
  if(data.cols <= 1) return data;
  const newCols = data.cols - 1;
  const keep = (c) => c < newCols;
  const cells = reKeySheetMap(data.cells, (r, c) => keep(c) ? (r + ',' + c) : null);
  const formats = reKeySheetMap(data.formats || {}, (r, c) => keep(c) ? (r + ',' + c) : null);
  const colWidths = reKeyIndexMap(data.colWidths, (c) => keep(c) ? c : null);
  const merges = adjustMergesForColDelete(data.merges, newCols);
  return Object.assign({}, data, { cols:newCols, cells, formats, colWidths, merges });
}

// "Insert/delete AT a position" - used by the row/column header context
// menu. Unlike the end-only functions above, these DO need to re-key
// every cell/format/width/height/merge at or past the affected index,
// since inserting/deleting in the middle shifts every subsequent
// row/column's index by one.
function insertSheetRowAt(data, atIndex){
  const idx = Math.max(0, Math.min(atIndex, data.rows));
  const shift = (r, c) => (r >= idx ? (r + 1) : r) + ',' + c;
  const cells = reKeySheetMap(data.cells, shift);
  const formats = reKeySheetMap(data.formats || {}, shift);
  const rowHeights = reKeyIndexMap(data.rowHeights, (r) => r >= idx ? r + 1 : r);
  const merges = adjustMergesForRowInsert(data.merges, idx);
  return Object.assign({}, data, { rows: data.rows + 1, cells, formats, rowHeights, merges });
}
function insertSheetColAt(data, atIndex){
  const idx = Math.max(0, Math.min(atIndex, data.cols));
  const shift = (r, c) => r + ',' + (c >= idx ? (c + 1) : c);
  const cells = reKeySheetMap(data.cells, shift);
  const formats = reKeySheetMap(data.formats || {}, shift);
  const colWidths = reKeyIndexMap(data.colWidths, (c) => c >= idx ? c + 1 : c);
  const merges = adjustMergesForColInsert(data.merges, idx);
  return Object.assign({}, data, { cols: data.cols + 1, cells, formats, colWidths, merges });
}
function deleteSheetRowAt(data, atIndex){
  if(data.rows <= 1) return data;
  const shift = (r, c) => (r === atIndex) ? null : ((r > atIndex ? r - 1 : r) + ',' + c);
  const cells = reKeySheetMap(data.cells, shift);
  const formats = reKeySheetMap(data.formats || {}, shift);
  const rowHeights = reKeyIndexMap(data.rowHeights, (r) => (r === atIndex) ? null : (r > atIndex ? r - 1 : r));
  const merges = adjustMergesForRowDelete(data.merges, atIndex);
  return Object.assign({}, data, { rows: data.rows - 1, cells, formats, rowHeights, merges });
}
function deleteSheetColAt(data, atIndex){
  if(data.cols <= 1) return data;
  const shift = (r, c) => (c === atIndex) ? null : (r + ',' + (c > atIndex ? c - 1 : c));
  const cells = reKeySheetMap(data.cells, shift);
  const formats = reKeySheetMap(data.formats || {}, shift);
  const colWidths = reKeyIndexMap(data.colWidths, (c) => (c === atIndex) ? null : (c > atIndex ? c - 1 : c));
  const merges = adjustMergesForColDelete(data.merges, atIndex);
  return Object.assign({}, data, { cols: data.cols - 1, cells, formats, colWidths, merges });
}

// ---- Merge / unmerge ----
function findMergeAt(merges, r, c){
  return (merges || []).find(m => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) || null;
}
// A cell's rendering contribution: whether to skip it entirely (it's
// covered by another cell's rowspan/colspan), and what span to use if
// it's the merge's own anchor (top-left) cell.
function cellSpanInfo(merges, r, c){
  const m = findMergeAt(merges, r, c);
  if(!m) return { skip:false, rowspan:1, colspan:1 };
  if(m.r0 === r && m.c0 === c) return { skip:false, rowspan: m.r1 - m.r0 + 1, colspan: m.c1 - m.c0 + 1 };
  return { skip:true, rowspan:1, colspan:1 };
}
function mergeCells(data, range){
  if(range.r0 === range.r1 && range.c0 === range.c1) return data; // a single cell isn't a merge
  // Any existing merge that overlaps the new range is replaced by it,
  // rather than left behind as an inconsistent overlapping rectangle.
  const merges = (data.merges || []).filter(m => !(m.r0 <= range.r1 && m.r1 >= range.r0 && m.c0 <= range.c1 && m.c1 >= range.c0));
  merges.push({ r0:range.r0, c0:range.c0, r1:range.r1, c1:range.c1 });
  // Only the anchor (top-left) cell's value survives - matches Excel's
  // own "merge cells" behavior (it warns and discards the rest; this
  // discards silently, which is worth knowing rather than assuming).
  const cells = Object.assign({}, data.cells);
  for(let r = range.r0; r <= range.r1; r++){
    for(let c = range.c0; c <= range.c1; c++){
      if(r === range.r0 && c === range.c0) continue;
      delete cells[r + ',' + c];
    }
  }
  return Object.assign({}, data, { cells, merges });
}
function unmergeCells(data, range){
  const merges = (data.merges || []).filter(m => !(m.r0 <= range.r1 && m.r1 >= range.r0 && m.c0 <= range.c1 && m.c1 >= range.c0));
  return Object.assign({}, data, { merges });
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
// ---- Cell formatting: bold, italic, text color, highlight, alignment.
// Stored as a SEPARATE sparse map (data.formats, keyed "r,c" same as
// cells) rather than folded into the cell value itself - keeps `cells`
// as plain strings, so nothing about parsing/TSV/Markdown interchange
// above needed to change to support this.
function pruneEmptyFormat(fmt){
  if(!fmt) return null;
  const hasAny = fmt.bold || fmt.italic || fmt.color || fmt.highlight || (fmt.align && fmt.align !== 'left');
  return hasAny ? fmt : null;
}
// Applies one formatting property to every cell in `range` ({r0,c0,r1,c1}).
// Entries that end up with no meaningful formatting are pruned rather
// than left behind as empty objects, keeping the formats map sparse.
function applyCellFormatValue(data, range, prop, value){
  const formats = Object.assign({}, data.formats);
  for(let r = range.r0; r <= range.r1; r++){
    for(let c = range.c0; c <= range.c1; c++){
      const key = r + ',' + c;
      const updated = Object.assign({}, formats[key], { [prop]: value });
      const pruned = pruneEmptyFormat(updated);
      if(pruned) formats[key] = pruned; else delete formats[key];
    }
  }
  return { rows:data.rows, cols:data.cols, cells:data.cells, formats };
}
// Toggle semantics matching Excel/Sheets: if EVERY cell in the range
// already has the property on, turn it off for all of them; otherwise
// turn it on for all of them (not just the ones missing it).
function toggleCellFormat(data, range, prop){
  let allOn = true;
  outer:
  for(let r = range.r0; r <= range.r1; r++){
    for(let c = range.c0; c <= range.c1; c++){
      const fmt = data.formats[r + ',' + c];
      if(!fmt || !fmt[prop]){ allOn = false; break outer; }
    }
  }
  return applyCellFormatValue(data, range, prop, !allOn);
}
// Builds the inline style attribute string for one cell's formatting -
// shared by both the interactive editor and the static preview/export
// renderer, so a cell looks identical in both places.
function sheetCellStyleAttr(fmt){
  if(!fmt) return '';
  const styles = [];
  if(fmt.bold) styles.push('font-weight:700');
  if(fmt.italic) styles.push('font-style:italic');
  if(fmt.color) styles.push('color:' + fmt.color);
  if(fmt.highlight) styles.push('background:' + fmt.highlight);
  if(fmt.align) styles.push('text-align:' + fmt.align);
  return styles.length ? (' style="' + styles.join(';') + '"') : '';
}

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
  table.classList.toggle('sheet-frozen', !!data.freeze);
  const freezeBtn = document.getElementById('sheetFreezeBtn');
  if(freezeBtn) freezeBtn.classList.toggle('canvas-toolbar-btn-active', !!data.freeze);

  const headerRow = document.createElement('tr');
  const cornerTh = document.createElement('th');
  if(data.freeze) cornerTh.classList.add('sheet-frozen-corner');
  headerRow.appendChild(cornerTh);
  for(let c = 0; c < data.cols; c++){
    const th = document.createElement('th');
    th.textContent = colLetter(c);
    th.className = 'sheet-col-header';
    th.style.width = ((data.colWidths && data.colWidths[c]) || DEFAULT_COL_WIDTH) + 'px';
    th.addEventListener('click', () => { setSheetSelection(0, c, data.rows - 1, c); renderSheetEditor(data); });
    th.addEventListener('contextmenu', (e) => { e.preventDefault(); showSheetHeaderMenu(e.clientX, e.clientY, 'col', c); });
    const colHandle = document.createElement('div');
    colHandle.className = 'sheet-col-resize-handle';
    colHandle.addEventListener('mousedown', (e) => startColResize(e, c));
    th.appendChild(colHandle);
    headerRow.appendChild(th);
  }
  table.appendChild(headerRow);

  for(let r = 0; r < data.rows; r++){
    const tr = document.createElement('tr');
    if(data.rowHeights && data.rowHeights[r]) tr.style.height = data.rowHeights[r] + 'px';
    const rowHeader = document.createElement('th');
    rowHeader.textContent = String(r + 1);
    rowHeader.className = 'sheet-row-header';
    rowHeader.addEventListener('click', () => { setSheetSelection(r, 0, r, data.cols - 1); renderSheetEditor(data); });
    rowHeader.addEventListener('contextmenu', (e) => { e.preventDefault(); showSheetHeaderMenu(e.clientX, e.clientY, 'row', r); });
    const rowHandle = document.createElement('div');
    rowHandle.className = 'sheet-row-resize-handle';
    rowHandle.addEventListener('mousedown', (e) => startRowResize(e, r));
    rowHeader.appendChild(rowHandle);
    tr.appendChild(rowHeader);

    for(let c = 0; c < data.cols; c++){
      const span = cellSpanInfo(data.merges, r, c);
      if(span.skip) continue; // covered by a merged cell's rowspan/colspan above/to the left

      const td = document.createElement('td');
      if(span.rowspan > 1) td.rowSpan = span.rowspan;
      if(span.colspan > 1) td.colSpan = span.colspan;
      if(isCellSelected(r, c)) td.classList.add('sheet-cell-selected');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = data.cells[r + ',' + c] || '';
      input.dataset.row = String(r);
      input.dataset.col = String(c);
      const fmt = (data.formats || {})[r + ',' + c];
      if(fmt){
        if(fmt.bold) input.style.fontWeight = '700';
        if(fmt.italic) input.style.fontStyle = 'italic';
        if(fmt.color) input.style.color = fmt.color;
        if(fmt.highlight) input.style.background = fmt.highlight;
        if(fmt.align) input.style.textAlign = fmt.align;
      }

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

// ---- Column width / row height resizing. Dragged live for visual
// feedback (directly adjusting DOM widths, not re-rendering the whole
// table on every mousemove - that would rebuild every input mid-drag and
// steal focus), committed to the actual data model only on mouseup.
function startColResize(e, c){
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const data = getCurrentSheetData();
  const origWidth = (data.colWidths && data.colWidths[c]) || DEFAULT_COL_WIDTH;
  const table = document.getElementById('sheetEditorTable');
  function onMove(ev){
    const newWidth = Math.max(30, origWidth + (ev.clientX - startX));
    Array.from(table.rows).forEach(row => {
      const cell = row.cells[c + 1]; // +1: index 0 is the row-header <th>
      if(cell) cell.style.width = newWidth + 'px';
    });
  }
  function onUp(ev){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const newWidth = Math.max(30, origWidth + (ev.clientX - startX));
    const d2 = getCurrentSheetData();
    d2.colWidths = Object.assign({}, d2.colWidths, { [c]: newWidth });
    saveSheetData(d2);
    renderSheetEditor(d2);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
function startRowResize(e, r){
  e.preventDefault();
  e.stopPropagation();
  const startY = e.clientY;
  const data = getCurrentSheetData();
  const origHeight = (data.rowHeights && data.rowHeights[r]) || DEFAULT_ROW_HEIGHT;
  const table = document.getElementById('sheetEditorTable');
  function onMove(ev){
    const newHeight = Math.max(18, origHeight + (ev.clientY - startY));
    if(table.rows[r + 1]) table.rows[r + 1].style.height = newHeight + 'px'; // +1: row 0 is the column-letter header row
  }
  function onUp(ev){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const newHeight = Math.max(18, origHeight + (ev.clientY - startY));
    const d2 = getCurrentSheetData();
    d2.rowHeights = Object.assign({}, d2.rowHeights, { [r]: newHeight });
    saveSheetData(d2);
    renderSheetEditor(d2);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

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

// Cell formatting: bold/italic toggle and alignment act on the whole
// current selection at once, matching the "select a range, hit bold"
// workflow from Excel/Sheets rather than a per-cell toggle.
document.getElementById('sheetBoldBtn').addEventListener('click', () => {
  if(!sheetSelection) return;
  const data = toggleCellFormat(getCurrentSheetData(), sheetSelection, 'bold');
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetItalicBtn').addEventListener('click', () => {
  if(!sheetSelection) return;
  const data = toggleCellFormat(getCurrentSheetData(), sheetSelection, 'italic');
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetAlignLeftBtn').addEventListener('click', () => {
  if(!sheetSelection) return;
  const data = applyCellFormatValue(getCurrentSheetData(), sheetSelection, 'align', 'left');
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetAlignCenterBtn').addEventListener('click', () => {
  if(!sheetSelection) return;
  const data = applyCellFormatValue(getCurrentSheetData(), sheetSelection, 'align', 'center');
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetAlignRightBtn').addEventListener('click', () => {
  if(!sheetSelection) return;
  const data = applyCellFormatValue(getCurrentSheetData(), sheetSelection, 'align', 'right');
  saveSheetData(data);
  renderSheetEditor(data);
});

document.getElementById('sheetMergeBtn').addEventListener('click', () => {
  if(!sheetSelection) return;
  const data = mergeCells(getCurrentSheetData(), sheetSelection);
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetUnmergeBtn').addEventListener('click', () => {
  if(!sheetSelection) return;
  const data = unmergeCells(getCurrentSheetData(), sheetSelection);
  saveSheetData(data);
  renderSheetEditor(data);
});
document.getElementById('sheetFreezeBtn').addEventListener('click', () => {
  const data = getCurrentSheetData();
  data.freeze = !data.freeze;
  saveSheetData(data);
  renderSheetEditor(data);
  document.getElementById('sheetFreezeBtn').classList.toggle('canvas-toolbar-btn-active', data.freeze);
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
