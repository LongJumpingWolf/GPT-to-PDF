/* =============================================================================
   export-import.js — sharing format (locked spec: zip of the unedited
   original PDF + a coords file), with fingerprint-matched import.

   Zip layout:
     manifest.json     { appId:'owclude', docFingerprint, pageCount, createdAt }
     source.pdf         the untouched original PDF bytes
     occlusions.json     [{ pageNumber, pageFingerprint, occlusions:[...] }]

   Requires JSZip (window.JSZip) already loaded.
   ============================================================================= */

async function exportPdfWithOcclusions(pdfRecord, occlusions){
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    appId: 'owclude',
    docFingerprint: pdfRecord.docFingerprint,
    pageCount: pdfRecord.pageCount,
    createdAt: new Date().toISOString(),
  }, null, 2));
  zip.file('source.pdf', pdfRecord.blob);

  const byPage = new Map();
  for(const occ of occlusions){
    if(!byPage.has(occ.pageNumber)) byPage.set(occ.pageNumber, []);
    byPage.get(occ.pageNumber).push({
      id: occ.id, x: occ.x, y: occ.y, w: occ.w, h: occ.h,
      label: occ.label || '', tags: occ.tags || [],
    });
  }
  const pages = [...byPage.entries()].map(([pageNumber, occs]) => ({
    pageNumber,
    pageFingerprint: pdfRecord.pageFingerprints[pageNumber - 1],
    occlusions: occs,
  }));
  zip.file('occlusions.json', JSON.stringify({ pages }, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(pdfRecord.name || 'occlusions').replace(/\.pdf$/i,'')}.owclude.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Parses a shared zip and returns everything needed to decide how to import
 * it, WITHOUT writing anything to the db yet.
 */
async function readImportZip(file){
  const zip = await JSZip.loadAsync(file);
  const manifestRaw = await zip.file('manifest.json').async('string');
  const manifest = JSON.parse(manifestRaw);
  if(manifest.appId !== 'owclude'){
    throw new Error('This file was not exported by Owclude.');
  }
  const pdfBlob = await zip.file('source.pdf').async('blob');
  const occlusionsRaw = await zip.file('occlusions.json').async('string');
  const occlusionsData = JSON.parse(occlusionsRaw);
  return { manifest, pdfBlob, occlusionsData };
}

/**
 * Matches each page in the import against a target pdf.js document's current
 * page fingerprints. Returns a plan: exact matches, realigned matches (page
 * shifted but found nearby/elsewhere), and unmatched pages needing manual
 * review — per the locked spec, exact matches auto-apply and only
 * realigned/unmatched need a review screen.
 */
async function buildImportPlan(occlusionsData, targetPdfDoc){
  const { docFingerprint, pageFingerprints } = await computeFingerprints(targetPdfDoc);
  const plan = { exact: [], realigned: [], unmatched: [], docFingerprint };

  for(const p of occlusionsData.pages){
    const localFp = pageFingerprints[p.pageNumber - 1];
    if(localFp === p.pageFingerprint){
      plan.exact.push({ ...p, resolvedPageNumber: p.pageNumber });
      continue;
    }
    const found = findPageByFingerprint(pageFingerprints, p.pageFingerprint, p.pageNumber);
    if(found){
      plan.realigned.push({ ...p, resolvedPageNumber: found, originalPageNumber: p.pageNumber });
    } else {
      plan.unmatched.push({ ...p, resolvedPageNumber: null });
    }
  }
  return plan;
}

/** Writes the accepted parts of a plan into the db as personal, fork-on-edit-eligible occlusions. */
async function applyImportPlan(plan, pdfId, acceptRealigned, acceptUnmatched){
  const toApply = [
    ...plan.exact,
    ...(acceptRealigned ? plan.realigned : []),
    ...(acceptUnmatched ? plan.unmatched.filter(p => p.resolvedPageNumber) : []),
  ];
  let count = 0;
  for(const p of toApply){
    if(!p.resolvedPageNumber) continue;
    for(const occ of p.occlusions){
      await putOcclusion({
        id: genId('occ'),
        pdfId,
        pageNumber: p.resolvedPageNumber,
        x: occ.x, y: occ.y, w: occ.w, h: occ.h,
        label: occ.label || '',
        tags: occ.tags || [],
        origin: 'imported',
        forkedFrom: null,
        createdAt: Date.now(),
      });
      count++;
    }
  }
  return count;
}
