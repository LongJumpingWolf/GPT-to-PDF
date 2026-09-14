/* =============================================================================
   fingerprint.js — content-based doc/page fingerprints.

   Deliberately NOT a file hash and NOT the PDF trailer /ID — both break on
   re-compression, metadata edits, or a re-export, which this pipeline does
   routinely. Instead: pull the actual text off each page via pdf.js,
   normalize it, and hash that. Survives anything that doesn't change what
   the page actually says.

   Requires pdf.js to already be loaded (window.pdfjsLib) and a PDFDocumentProxy.
   ============================================================================= */

async function sha256Hex(str){
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function normalizeText(str){
  return (str || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function extractPageText(pdfDoc, pageNumber){
  const page = await pdfDoc.getPage(pageNumber);
  const content = await page.getTextContent();
  return normalizeText(content.items.map(it => it.str).join(' '));
}

async function computeFingerprints(pdfDoc){
  const pageFingerprints = [];
  let allText = '';
  for(let i = 1; i <= pdfDoc.numPages; i++){
    const text = await extractPageText(pdfDoc, i);
    allText += text + ' ';
    pageFingerprints.push(await sha256Hex(text || `__blank_page_${i}__`));
  }
  const docFingerprint = await sha256Hex(normalizeText(allText));
  return { docFingerprint, pageFingerprints };
}

/**
 * Given a target page fingerprint and its expected page number, search a
 * window around that page first (cheap, covers the common "one page got
 * inserted/removed nearby" case), then fall back to a full scan.
 * Returns the matching page number (1-indexed) or null.
 */
function findPageByFingerprint(pageFingerprints, targetFingerprint, expectedPageNumber){
  const n = pageFingerprints.length;
  const window = 5;
  const start = Math.max(1, expectedPageNumber - window);
  const end = Math.min(n, expectedPageNumber + window);
  for(let p = start; p <= end; p++){
    if(pageFingerprints[p-1] === targetFingerprint) return p;
  }
  for(let p = 1; p <= n; p++){
    if(pageFingerprints[p-1] === targetFingerprint) return p;
  }
  return null;
}
