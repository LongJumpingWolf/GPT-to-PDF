/* =============================================================================
   storage.js — the IndexedDB layer for Study Notes.

   Everything in this file is about getting data in and out of IndexedDB.
   It does NOT know about the DOM, routing, or the editor UI - the only
   things it expects to exist elsewhere (defined in index.html's own
   script, loaded after this one) are a handful of shared app-state
   variables it reads from and a `broadcast()` function for cross-tab
   messaging. Everything here is plain function declarations rather than
   an IIFE/module, so it shares the page's single global scope with
   index.html's script - see the note at the bottom of this file for why
   that's safe despite the load order.

   Two object stores:
     - "docs"   -> one record PER DOCUMENT: { id, title, titleAuto,
                   columns, activeCol, createdAt, updatedAt }
     - "images" -> one record per embedded image (shared across all
                   documents - see the comment on gcUnusedImages() below
                   for why that's deliberate, not an oversight)

   DB_VERSION bumped 1 -> 2 to move from the old single-document "doc"
   store to the multi-document "docs" store. The upgrade migrates
   whatever single note existed (from any earlier version of this app,
   including the pre-IndexedDB localStorage-only days) into the first
   entry of the new store, then retires the old store entirely.
   ============================================================================= */

const DB_NAME = 'studyNoteEditorDB';
const DB_VERSION = 2;
let dbPromise = null;

function deriveTitleFromColumns(colsArr){
  const first = (colsArr && colsArr[0]) || '';
  const headingMatch = first.match(/^#\s+(.+)$/m);
  if(headingMatch && headingMatch[1].trim()) return headingMatch[1].trim().slice(0, 80);
  const firstLine = (first.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('![')) || '');
  return firstLine ? firstLine.replace(/^#+\s*/, '').slice(0, 80) : 'Untitled note';
}

function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      if(!db.objectStoreNames.contains('images')){
        db.createObjectStore('images', { keyPath:'id' });
      }
      if(!db.objectStoreNames.contains('docs')){
        const docsStore = db.createObjectStore('docs', { keyPath:'id' });
        const tx = event.target.transaction;

        const migrateAndCleanup = (legacyRecord) => {
          let sourceColumns = null, sourceActiveCol = 0;
          if(legacyRecord && Array.isArray(legacyRecord.columns) && legacyRecord.columns.length){
            sourceColumns = legacyRecord.columns;
            sourceActiveCol = legacyRecord.activeCol || 0;
          } else {
            // Even older: plain localStorage-only versions, from before
            // this app used IndexedDB at all.
            try{
              const raw = localStorage.getItem('study-note-editor-columns-v3') || localStorage.getItem('study-note-editor-columns-v2');
              if(raw){
                const parsed = JSON.parse(raw);
                if(Array.isArray(parsed) && parsed.length) sourceColumns = parsed;
              }
            }catch(e){}
          }
          if(sourceColumns){
            const now = Date.now();
            docsStore.put({
              id: 'doc-' + now,
              title: deriveTitleFromColumns(sourceColumns),
              titleAuto: true,
              columns: sourceColumns,
              activeCol: sourceActiveCol,
              createdAt: now,
              updatedAt: now
            });
            try{
              localStorage.removeItem('study-note-editor-columns-v3');
              localStorage.removeItem('study-note-editor-columns-v2');
            }catch(e){}
          }
          if(db.objectStoreNames.contains('doc')){
            db.deleteObjectStore('doc');
          }
        };

        if(db.objectStoreNames.contains('doc')){
          const getReq = tx.objectStore('doc').get('main');
          getReq.onsuccess = () => migrateAndCleanup(getReq.result);
          getReq.onerror = () => migrateAndCleanup(null);
        } else {
          migrateAndCleanup(null);
        }
      }
    };

    // If another tab still has an OLDER version of this app open with a
    // live connection, the browser can't run the version upgrade until
    // that connection closes - it fires "blocked" instead of "success".
    // We can't force-close another tab's connection, so just surface it.
    req.onblocked = () => {
      console.warn('IndexedDB upgrade blocked - close other tabs of this app and reload.');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbPut(store, value){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(store, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetAll(store){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbGetAllKeys(store){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(store, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function formatBytes(n){
  if(n == null) return '';
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(0) + ' KB';
  if(n < 1024*1024*1024) return (n/(1024*1024)).toFixed(1) + ' MB';
  return (n/(1024*1024*1024)).toFixed(2) + ' GB';
}
async function updateStorageInfo(){
  try{
    if(navigator.storage && navigator.storage.estimate){
      const { usage, quota } = await navigator.storage.estimate();
      if(usage != null && quota != null){
        const text = `${formatBytes(usage)} used of ~${formatBytes(quota)} available`;
        const a = document.getElementById('storageInfo');
        const b = document.getElementById('homeStorageInfo');
        if(a) a.textContent = text;
        if(b) b.textContent = text;
      }
    }
  }catch(e){}
}
if(navigator.storage && navigator.storage.persist){
  navigator.storage.persist().catch(() => {});
}

// ---- Document persistence ----
// Reads currentDocId / columns / activeCol / docTitle / titleAuto /
// currentDocCreatedAt / deletedElsewhere from index.html's script (the
// active document's in-memory state) and calls its broadcast() to notify
// other tabs. See the file header for why this cross-file reference is
// safe: this function's BODY only runs when something calls persistDoc(),
// which never happens until well after index.html's script has finished
// initializing those bindings.
async function persistDoc(){
  // No doc loaded, or this doc was deleted from another tab - never
  // write. Writing after a cross-tab delete would just re-create
  // ("resurrect") the record under the same id via put()'s upsert
  // behavior, which is exactly what deletedElsewhere exists to prevent.
  if(!currentDocId || deletedElsewhere) return false;
  try{
    await idbPut('docs', {
      id: currentDocId,
      title: docTitle || 'Untitled note',
      titleAuto,
      columns,
      activeCol,
      createdAt: currentDocCreatedAt || Date.now(),
      updatedAt: Date.now()
    });
    broadcast({ type:'docs-changed' });
    return true;
  }catch(e){
    return false;
  }
}

// Deletes any stored image no longer referenced by img://<id> in ANY
// document - not just the one currently open. Images are a single shared
// store rather than being namespaced per-document: ids are
// crypto.randomUUID()'d (effectively zero collision risk), and if someone
// ever copy-pastes raw markdown containing an img://id from one document
// into another, both documents legitimately end up referencing the SAME
// stored image - which is a reasonable thing to allow, not a bug. But it
// means "is this image still needed" can only be answered by checking
// every document, not just the one you happen to be looking at; scanning
// only the active document here would delete images the moment you're not
// looking at the other document that still uses them.
async function gcUnusedImages(){
  try{
    const used = new Set();
    const re = /img:\/\/([a-zA-Z0-9-]+)/g;
    let allDocs = [];
    try{ allDocs = await idbGetAll('docs'); }catch(e){}
    allDocs.forEach(doc => {
      (doc.columns || []).forEach(text => {
        let m;
        while((m = re.exec(text || '')) !== null) used.add(m[1]);
      });
    });
    // Also fold in the currently open document's in-memory columns, in
    // case an edit hasn't been persisted yet at the moment this runs.
    if(currentDocId){
      columns.forEach(text => {
        let m;
        while((m = re.exec(text || '')) !== null) used.add(m[1]);
      });
    }
    const keys = await idbGetAllKeys('images');
    let deleted = 0;
    for(const key of keys){
      if(used.has(key)) continue;
      await idbDelete('images', key);
      const meta = imgMetaCache.get(key);
      if(meta && meta.url){ URL.revokeObjectURL(meta.url); }
      imgMetaCache.delete(key);
      deleted++;
    }
    return deleted;
  }catch(e){
    return 0;
  }
}

// Full wipe - unlike gcUnusedImages() (which only removes images no
// longer referenced anywhere), this deletes EVERY document and image.
async function deleteAllDocuments(){
  // Using indexedDB.deleteDatabase() instead of clearing each store one
  // by one. store.clear() only empties rows - the database's underlying
  // file on disk stays allocated at whatever size it grew to, and
  // browsers don't necessarily shrink it back down right away (or ever,
  // without an idle-time compaction pass). deleteDatabase() removes the
  // entire backing file, which is a much stronger signal to the browser
  // to actually reclaim that space, rather than just marking rows as
  // gone inside a file that's still sitting there at its old size.
  try{
    if(dbPromise){
      const existingDb = await dbPromise;
      existingDb.close();
    }
  }catch(e){}
  dbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve(); // don't hang the UI if this fails
    req.onblocked = () => {
      // Another tab still has a connection open to this database, so the
      // browser can't delete the file until that connection closes. Local
      // in-memory state is cleared either way below; the delete itself
      // will finish once other tabs are closed.
      console.warn('Database delete blocked - close other tabs of this app for it to complete.');
      resolve();
    };
  });
  try{
    localStorage.removeItem('study-note-editor-columns-v2');
    localStorage.removeItem('study-note-editor-columns-v3');
  }catch(e){}
  imgMetaCache.forEach(meta => { if(meta && meta.url) URL.revokeObjectURL(meta.url); });
  imgMetaCache.clear();
  legacySizeCache.clear();
  broadcast({ type:'all-deleted' });
  broadcast({ type:'docs-changed' });
}

/* -----------------------------------------------------------------------
   On cross-file references: persistDoc(), gcUnusedImages(), and
   deleteAllDocuments() above read variables (currentDocId, columns,
   activeCol, docTitle, titleAuto, currentDocCreatedAt, deletedElsewhere,
   imgMetaCache, legacySizeCache) and call a function (broadcast) that are
   all declared with `let`/`const`/`function` in index.html's <script>,
   which loads AFTER this file. That's fine: multiple classic <script>
   tags in one document share a single top-level lexical scope, and a
   function's BODY is only evaluated when it's actually CALLED, not when
   it's defined - by the time anything in index.html's script calls
   persistDoc() etc. (which only happens after that script has finished
   running top-to-bottom and initialized all of it), every name referenced
   here already exists. The one thing this ordering would NOT tolerate is
   this file trying to READ any of those names at its own top level
   (outside a function body) - it doesn't; the only top-level statement
   here is the navigator.storage.persist() call, which is self-contained.
   ----------------------------------------------------------------------- */
