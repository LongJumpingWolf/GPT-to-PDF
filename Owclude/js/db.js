/* =============================================================================
   db.js — Owclude's IndexedDB layer. Fully separate database from the parent
   Study Notes app ("owclude", not "study-notes") — no shared stores, no
   collision risk with the note editor's own data.

   Three stores:
     "pdfs"       -> { id, name, blob, pageCount, docFingerprint,
                       pageFingerprints: string[], importedAt, supersedes }
     "occlusions" -> { id, pdfId, pageNumber, x, y, w, h, label, tags: string[],
                        origin: 'personal' | 'imported', forkedFrom, createdAt }
     "reviews"    -> { id, occlusionId, timestamp, result: 'correct'|'incorrect',
                        ease, interval, dueAt }

   Everything here is plain async functions against a single shared `db`
   handle opened once via openDB(). No DOM references — this file only
   knows about IndexedDB.
   ============================================================================= */

const DB_NAME = 'owclude';
const DB_VERSION = 1;
let dbHandle = null;

function openDB(){
  if(dbHandle) return Promise.resolve(dbHandle);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('pdfs')){
        db.createObjectStore('pdfs', { keyPath:'id' });
      }
      if(!db.objectStoreNames.contains('occlusions')){
        const occ = db.createObjectStore('occlusions', { keyPath:'id' });
        occ.createIndex('by_pdf', 'pdfId', { unique:false });
      }
      if(!db.objectStoreNames.contains('reviews')){
        const rev = db.createObjectStore('reviews', { keyPath:'id' });
        rev.createIndex('by_occlusion', 'occlusionId', { unique:false });
      }
    };
    req.onsuccess = (e) => { dbHandle = e.target.result; resolve(dbHandle); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode){
  return openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function genId(prefix){
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
}

/* ---- pdfs store ---- */

async function putPdf(record){
  const store = await tx('pdfs', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getPdf(id){
  const store = await tx('pdfs', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function listPdfs(){
  const store = await tx('pdfs', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function deletePdf(id){
  const store = await tx('pdfs', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

/* ---- occlusions store ---- */

async function putOcclusion(occ){
  const store = await tx('occlusions', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(occ);
    req.onsuccess = () => resolve(occ);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function deleteOcclusion(id){
  const store = await tx('occlusions', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getOcclusionsForPdf(pdfId){
  const store = await tx('occlusions', 'readonly');
  return new Promise((resolve, reject) => {
    const idx = store.index('by_pdf');
    const req = idx.getAll(pdfId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

/* ---- reviews store ---- */

async function addReview(review){
  const store = await tx('reviews', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(review);
    req.onsuccess = () => resolve(review);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getReviewsForOcclusion(occlusionId){
  const store = await tx('reviews', 'readonly');
  return new Promise((resolve, reject) => {
    const idx = store.index('by_occlusion');
    const req = idx.getAll(occlusionId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getAllReviewsForPdf(pdfId, occlusions){
  // occlusions passed in to avoid a second pdfId index — reviews are keyed
  // by occlusionId only, so we fan out across the pdf's occlusion ids.
  const lists = await Promise.all(occlusions.map(o => getReviewsForOcclusion(o.id)));
  return lists.flat();
}
