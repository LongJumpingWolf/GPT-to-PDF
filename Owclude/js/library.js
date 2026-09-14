/* =============================================================================
   library.js — glue for index.html (the Owclude library screen).
   ============================================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js';

const libGrid = document.getElementById('libGrid');
const libEmpty = document.getElementById('libEmpty');
const libStatus = document.getElementById('libStatus');
const pdfInput = document.getElementById('pdfInput');
const zipInput = document.getElementById('zipInput');

document.getElementById('importPdfBtn').addEventListener('click', () => pdfInput.click());
document.getElementById('importZipBtn').addEventListener('click', () => zipInput.click());

pdfInput.addEventListener('change', async () => {
  const file = pdfInput.files[0];
  pdfInput.value = '';
  if(!file) return;
  await importNewPdf(file);
});

zipInput.addEventListener('change', async () => {
  const file = zipInput.files[0];
  zipInput.value = '';
  if(!file) return;
  await importSharedZip(file);
});

async function importNewPdf(file){
  libStatus.textContent = `Reading ${file.name}…`;
  const buf = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  libStatus.textContent = `Fingerprinting ${pdfDoc.numPages} pages…`;
  const { docFingerprint, pageFingerprints } = await computeFingerprints(pdfDoc);

  const record = {
    id: genId('pdf'),
    name: file.name,
    blob: file, // File is a Blob subtype — stores fine directly in IndexedDB
    pageCount: pdfDoc.numPages,
    docFingerprint,
    pageFingerprints,
    importedAt: Date.now(),
    supersedes: null,
  };
  await putPdf(record);
  libStatus.textContent = '';
  renderLibrary();
}

async function importSharedZip(file){
  libStatus.textContent = 'Reading shared file…';
  let parsed;
  try{
    parsed = await readImportZip(file);
  } catch(e){
    libStatus.textContent = `Could not import: ${e.message}`;
    return;
  }

  const existing = (await listPdfs()).find(p => p.docFingerprint === parsed.manifest.docFingerprint);
  let pdfId, pdfDoc;

  if(existing){
    pdfId = existing.id;
    const buf = await existing.blob.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
  } else {
    const buf = await parsed.pdfBlob.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const { docFingerprint, pageFingerprints } = await computeFingerprints(pdfDoc);
    const record = {
      id: genId('pdf'),
      name: file.name.replace(/\.owclude\.zip$|\.zip$/i, '.pdf'),
      blob: parsed.pdfBlob,
      pageCount: pdfDoc.numPages,
      docFingerprint,
      pageFingerprints,
      importedAt: Date.now(),
      supersedes: null,
    };
    await putPdf(record);
    pdfId = record.id;
  }

  libStatus.textContent = 'Matching occlusions to pages…';
  const plan = await buildImportPlan(parsed.occlusionsData, pdfDoc);

  let acceptRealigned = true, acceptUnmatched = false;
  if(plan.realigned.length || plan.unmatched.length){
    const msg = `${plan.exact.length} pages matched exactly.\n` +
      `${plan.realigned.length} pages shifted but were found nearby — include them?\n` +
      `${plan.unmatched.length} pages could not be matched and will be skipped.`;
    acceptRealigned = plan.realigned.length ? confirm(msg + '\n\nOK = include realigned pages, Cancel = skip them too.') : true;
  }

  const count = await applyImportPlan(plan, pdfId, acceptRealigned, acceptUnmatched);
  libStatus.textContent = `Imported ${count} occlusion(s).`;
  renderLibrary();
}

function fmtDate(ts){
  return new Date(ts).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}

async function renderLibrary(){
  const pdfs = await listPdfs();
  libGrid.innerHTML = '';
  libEmpty.classList.toggle('hidden', pdfs.length > 0);
  pdfs.sort((a,b) => b.importedAt - a.importedAt);
  for(const p of pdfs){
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.innerHTML = `
      <div class="lib-card-row">
        <div class="name">${escapeHtmlLib(p.name)}</div>
        <button class="del" data-id="${p.id}">Delete</button>
      </div>
      <div class="meta mono">${p.pageCount} pages · imported ${fmtDate(p.importedAt)}</div>
    `;
    card.addEventListener('click', (e) => {
      if(e.target.closest('.del')) return;
      window.location.href = `/Owclude/study.html?pdf=${encodeURIComponent(p.id)}`;
    });
    card.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if(!confirm(`Delete "${p.name}" and all its occlusions? This can't be undone.`)) return;
      const occs = await getOcclusionsForPdf(p.id);
      for(const o of occs) await deleteOcclusion(o.id);
      await deletePdf(p.id);
      renderLibrary();
    });
    libGrid.appendChild(card);
  }
}

function escapeHtmlLib(s){
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

renderLibrary();
