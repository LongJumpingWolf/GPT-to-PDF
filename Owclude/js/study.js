/* =============================================================================
   study.js — glue for study.html (the Split Focus study screen).
   ============================================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const params = new URLSearchParams(window.location.search);
const pdfId = params.get('pdf');

const viewerScroll = document.getElementById('viewerScroll');
const docTitleEl = document.getElementById('docTitle');
const viewerStatus = document.getElementById('viewerStatus');
const pageInput = document.getElementById('pageInput');
const pageCountEl = document.getElementById('pageCount');

let pdfRecord = null;
let pdfDoc = null;
let renderer = null;
let occlusionLayer = null;
let allOcclusions = [];
let occlusionsByPage = new Map();
let selectedOcclusion = null; // the persisted occlusion currently shown in the panel
let draftOcclusion = null;    // an unsaved just-drawn occlusion, if any

async function init(){
  if(!pdfId){ viewerStatus.textContent = 'No PDF specified.'; return; }
  pdfRecord = await getPdf(pdfId);
  if(!pdfRecord){ viewerStatus.textContent = 'PDF not found in library.'; return; }
  docTitleEl.textContent = pdfRecord.name;
  pageCountEl.textContent = pdfRecord.pageCount;
  pageInput.max = pdfRecord.pageCount;

  viewerStatus.textContent = 'Loading…';
  const buf = await pdfRecord.blob.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;

  allOcclusions = await getOcclusionsForPdf(pdfId);
  rebuildPageIndex();

  occlusionLayer = createOcclusionLayer({
    onCreate: handleOcclusionDrawn,
    onSelect: (occ) => selectOcclusion(occ),
  });

  renderer = await createPdfRenderer({
    pdfDoc,
    container: viewerScroll,
    onPageRendered: (pageNumber, wrapper) => {
      occlusionLayer.attachToPage(pageNumber, wrapper);
      occlusionLayer.setOcclusionsForPage(pageNumber, occlusionsByPage.get(pageNumber) || []);
    },
    onPageUnmounted: (pageNumber) => occlusionLayer.detachFromPage(pageNumber),
  });

  viewerStatus.textContent = '';
  pageInput.value = 1;

  let lastReportedPage = 1;
  viewerScroll.addEventListener('scroll', () => {
    requestAnimationFrame(() => {
      const cur = renderer.getCurrentPage();
      pageInput.value = cur;
      // reset the reveal-all toggle when the visible page changes
      if(cur !== lastReportedPage){
        lastReportedPage = cur;
        if(allRevealed){
          allRevealed = false;
          revealAllBtn.textContent = 'Reveal all';
          revealAllBtn.classList.remove('active');
        }
      }
    });
  });
}

function rebuildPageIndex(){
  occlusionsByPage = new Map();
  for(const occ of allOcclusions){
    if(!occlusionsByPage.has(occ.pageNumber)) occlusionsByPage.set(occ.pageNumber, []);
    occlusionsByPage.get(occ.pageNumber).push(occ);
  }
}

function refreshCurrentPageOverlay(pageNumber){
  if(occlusionLayer) occlusionLayer.setOcclusionsForPage(pageNumber, occlusionsByPage.get(pageNumber) || []);
}

/* ---- Toolbar: mode + blanket style ---- */

const modeViewBtn = document.getElementById('modeViewBtn');
const modeAddBtn = document.getElementById('modeAddBtn');
modeViewBtn.addEventListener('click', () => setMode('view'));
modeAddBtn.addEventListener('click', () => setMode('add'));
function setMode(m){
  occlusionLayer.setMode(m);
  modeViewBtn.classList.toggle('active', m === 'view');
  modeAddBtn.classList.toggle('active', m === 'add');
}

const blanketSolidBtn = document.getElementById('blanketSolidBtn');
const blanketTransparentBtn = document.getElementById('blanketTransparentBtn');
blanketSolidBtn.addEventListener('click', () => setBlanket('solid'));
blanketTransparentBtn.addEventListener('click', () => setBlanket('transparent'));
function setBlanket(style){
  occlusionLayer.setBlanketStyle(style);
  blanketSolidBtn.classList.toggle('active', style === 'solid');
  blanketTransparentBtn.classList.toggle('active', style === 'transparent');
}

// Reveal-all / hide-all toggle for the current page (the standard "toggle masks")
const revealAllBtn = document.getElementById('revealAllBtn');
let allRevealed = false;
function toggleRevealAll(){
  allRevealed = !allRevealed;
  occlusionLayer.setAllRevealed(renderer.getCurrentPage(), allRevealed);
  revealAllBtn.textContent = allRevealed ? 'Hide all' : 'Reveal all';
  revealAllBtn.classList.toggle('active', allRevealed);
}
revealAllBtn.addEventListener('click', toggleRevealAll);

/* ---- Page navigation ---- */

document.getElementById('prevPageBtn').addEventListener('click', () => {
  const p = Math.max(1, renderer.getCurrentPage() - 1);
  renderer.scrollToPage(p);
});
document.getElementById('nextPageBtn').addEventListener('click', () => {
  const p = Math.min(renderer.getNumPages(), renderer.getCurrentPage() + 1);
  renderer.scrollToPage(p);
});
pageInput.addEventListener('change', () => {
  const p = Math.max(1, Math.min(pdfRecord.pageCount, Number(pageInput.value) || 1));
  renderer.scrollToPage(p);
});

/* ---- Detail panel ---- */

const detailEmpty = document.getElementById('detailEmpty');
const detailForm = document.getElementById('detailForm');
const occLabelInput = document.getElementById('occLabelInput');
const occTagsInput = document.getElementById('occTagsInput');
const occTierChip = document.getElementById('occTierChip');
const occOriginNote = document.getElementById('occOriginNote');
const statsBody = document.getElementById('statsBody');

function handleOcclusionDrawn({ pageNumber, x, y, w, h }){
  draftOcclusion = {
    id: genId('occ'), pdfId, pageNumber, x, y, w, h,
    label: '', tags: [], origin: 'personal', forkedFrom: null, createdAt: Date.now(),
  };
  selectedOcclusion = null;
  openDetailForm(draftOcclusion, true);
}

async function selectOcclusion(occ){
  draftOcclusion = null;
  selectedOcclusion = occ;
  await openDetailForm(occ, false);
}

async function openDetailForm(occ, isDraft){
  detailEmpty.classList.add('hidden');
  detailForm.classList.remove('hidden');
  occLabelInput.value = occ.label || '';
  occTagsInput.value = (occ.tags || []).join(', ');
  occOriginNote.textContent = (!isDraft && occ.origin === 'imported')
    ? 'From a shared set — editing will save your own personal copy.'
    : '';

  if(isDraft){
    occTierChip.innerHTML = '';
    statsBody.innerHTML = '<div class="panel-empty">Not saved yet — reviews start after you save this occlusion.</div>';
  } else {
    await refreshStatsForOcclusion(occ);
  }
}

async function refreshStatsForOcclusion(occ){
  const reviews = await getReviewsForOcclusion(occ.id);
  const tier = computeDifficultyTier(reviews);
  occTierChip.innerHTML = `<span class="tag-chip tier-${tier}">${TIER_LABEL[tier]}</span>`;

  if(reviews.length === 0){
    statsBody.innerHTML = '<div class="panel-empty">No reviews yet.</div>';
    return;
  }
  const acc = computeAccuracy(reviews);
  const sorted = [...reviews].sort((a,b) => b.timestamp - a.timestamp);
  const last = sorted[0];
  const dueStr = last.dueAt ? new Date(last.dueAt).toLocaleDateString() : '–';
  statsBody.innerHTML = `
    <div class="stat-row"><span class="stat-label">Reviews</span><span class="mono">${reviews.length}</span></div>
    <div class="stat-row"><span class="stat-label">Accuracy</span><span class="mono">${Math.round(acc*100)}%</span></div>
    <div class="stat-row"><span class="stat-label">Ease</span><span class="mono">${last.ease?.toFixed(2) ?? '–'}</span></div>
    <div class="stat-row"><span class="stat-label">Interval</span><span class="mono">${last.interval ?? '–'}d</span></div>
    <div class="stat-row"><span class="stat-label">Next due</span><span class="mono">${dueStr}</span></div>
  `;
}

function clearDetailForm(){
  draftOcclusion = null;
  selectedOcclusion = null;
  detailForm.classList.add('hidden');
  detailEmpty.classList.remove('hidden');
}

document.getElementById('saveOccBtn').addEventListener('click', async () => {
  const label = occLabelInput.value.trim();
  const tags = occTagsInput.value.split(',').map(t => t.trim()).filter(Boolean);

  if(draftOcclusion){
    const occ = { ...draftOcclusion, label, tags };
    await putOcclusion(occ);
    allOcclusions.push(occ);
    rebuildPageIndex();
    refreshCurrentPageOverlay(occ.pageNumber);
    draftOcclusion = null;
    selectedOcclusion = occ;
    occOriginNote.textContent = '';
    return;
  }

  if(selectedOcclusion){
    if(selectedOcclusion.origin === 'imported'){
      // fork-on-edit: leave the imported original untouched, save a personal copy
      const forked = {
        ...selectedOcclusion,
        id: genId('occ'), label, tags,
        origin: 'personal', forkedFrom: selectedOcclusion.id, createdAt: Date.now(),
      };
      await putOcclusion(forked);
      allOcclusions.push(forked);
      rebuildPageIndex();
      refreshCurrentPageOverlay(forked.pageNumber);
      selectedOcclusion = forked;
      occOriginNote.textContent = 'Saved as your personal copy.';
    } else {
      const updated = { ...selectedOcclusion, label, tags };
      await putOcclusion(updated);
      const idx = allOcclusions.findIndex(o => o.id === updated.id);
      if(idx >= 0) allOcclusions[idx] = updated;
      rebuildPageIndex();
      refreshCurrentPageOverlay(updated.pageNumber);
      selectedOcclusion = updated;
    }
  }
});

document.getElementById('deleteOccBtn').addEventListener('click', async () => {
  const occ = selectedOcclusion || draftOcclusion;
  if(!occ) return;
  if(!draftOcclusion && !confirm('Delete this occlusion and its review history?')) return;
  if(!draftOcclusion){
    await deleteOcclusion(occ.id);
    allOcclusions = allOcclusions.filter(o => o.id !== occ.id);
    rebuildPageIndex();
  }
  refreshCurrentPageOverlay(occ.pageNumber);
  clearDetailForm();
});

async function recordReview(result){
  const occ = selectedOcclusion;
  if(!occ){ alert('Save this occlusion before reviewing it.'); return; }
  const priorReviews = await getReviewsForOcclusion(occ.id);
  const priorState = priorStateFromReviews(priorReviews);
  const next = computeNextReviewState(priorState, result);
  await addReview({
    id: genId('rev'), occlusionId: occ.id, timestamp: Date.now(), result,
    ease: next.ease, interval: next.interval, dueAt: next.dueAt,
  });
  await refreshStatsForOcclusion(occ);
}
document.getElementById('markCorrectBtn').addEventListener('click', () => recordReview('correct'));
document.getElementById('markIncorrectBtn').addEventListener('click', () => recordReview('incorrect'));

/* ---- Keyboard shortcuts ---- */
// Skip when typing in a field, so labels/tags entry isn't hijacked.
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if(e.metaKey || e.ctrlKey || e.altKey) return;

  switch(e.key.toLowerCase()){
    case 'r': e.preventDefault(); toggleRevealAll(); break;
    case 'c': if(selectedOcclusion){ e.preventDefault(); recordReview('correct'); } break;
    case 'x': if(selectedOcclusion){ e.preventDefault(); recordReview('incorrect'); } break;
    case '[': e.preventDefault(); renderer.scrollToPage(Math.max(1, renderer.getCurrentPage() - 1)); break;
    case ']': e.preventDefault(); renderer.scrollToPage(Math.min(renderer.getNumPages(), renderer.getCurrentPage() + 1)); break;
  }
});

/* ---- Export ---- */

document.getElementById('exportBtn').addEventListener('click', async () => {
  if(allOcclusions.length === 0){ alert('No occlusions to share yet.'); return; }
  await exportPdfWithOcclusions(pdfRecord, allOcclusions);
});

init();
