/**
 * Read a PDF in the browser with pdf.js (parsing runs in pdf.js's own worker, so the
 * page stays responsive and the file never leaves this tab). Only text and the
 * outline are extracted; nothing is rendered. Extraction and book-building live in
 * src/shared/book.js so the Node tests run the same code on a real PDF.
 */
import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs';
import { extractBook } from '/shared/book.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

export const MAX_PDF_BYTES = 300 * 1024 * 1024;

/**
 * @param {File} file
 * @param {{onProgress?: (done: number, total: number) => void, signal?: AbortSignal}} [opts]
 * @returns {Promise<import('/shared/book.js').Book>}
 */
export async function loadPdf(file, opts = {}) {
  if (file.size > MAX_PDF_BYTES) throw new Error('That PDF is larger than 300 MB.');
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    // Text extraction only: no font injection into the page, no XFA forms.
    disableFontFace: true,
    enableXfa: false,
    stopAtErrors: false,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  });
  const abort = () => task.destroy();
  opts.signal?.addEventListener('abort', abort, { once: true });
  try {
    const doc = await task.promise;
    return await extractBook(doc, { ...opts, fallbackTitle: file.name.replace(/\.pdf$/i, '') });
  } catch (err) {
    if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const name = /** @type {Error} */ (err)?.name;
    if (name === 'PasswordException')
      throw new Error('That PDF is password-protected. Remove the password and try again.', { cause: err });
    if (name === 'InvalidPDFException') throw new Error('That file is not a valid PDF.', { cause: err });
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    // pdf.js 6: the loading task owns cleanup (the document proxy has no destroy()).
    task.destroy().catch(() => {});
  }
}
