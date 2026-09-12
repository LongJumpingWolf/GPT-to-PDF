/* =============================================================================
   columns.js — shared column-type utility.

   Deliberately not a schema change to the columns array itself - it stays
   string[], exactly as every existing document already has it stored. A
   canvas/sheet column is just a normal string that happens to start with
   a type marker followed by a JSON blob:
     <!--type:canvas-->{"width":720,"height":480,"elements":[...]}
     <!--type:sheet-->{"rows":6,"cols":4,"cells":{"0,0":"..."}}
   A column with no marker is plain markdown, unchanged from before.

   This keeps every existing piece of column-level machinery working
   without modification: drag-reorder, the export column picker, delete
   column, and - importantly - image garbage collection, which just does
   a blind regex scan of each column's raw text for "img://<id>"
   occurrences. Canvas images are stored as that exact same "img://<id>"
   string inside their element's JSON, so the existing GC scanner finds
   them with zero changes, whether the surrounding text is markdown or
   JSON.

   Loaded before canvas.js/sheet.js/storage.js/index.html's own script,
   all of which call getColumnType()/escapeHtml() - safe per the same
   cross-file reference convention used throughout this app: a function's
   body is only evaluated when it's actually CALLED, well after every
   script has finished loading.
   ============================================================================= */

const CANVAS_MARKER = '<!--type:canvas-->';
const SHEET_MARKER = '<!--type:sheet-->';

function getColumnType(text){
  const t = text || '';
  if(t.startsWith(CANVAS_MARKER)) return 'canvas';
  if(t.startsWith(SHEET_MARKER)) return 'sheet';
  return 'text';
}

function escapeHtml(s){
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
