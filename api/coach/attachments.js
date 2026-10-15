import zlib from 'node:zlib';

/* Files a person attaches to a plan request: a PDF or a photo of a plan they already have.
 *
 * Everything that decides whether a file may go to a provider lives here, so the route, the
 * queue and the status poll cannot disagree about it. The bytes themselves are never stored:
 * they ride on the in-memory job and nowhere else (docs/dev/coach-attachments.md §5).
 */

export const ATTACHMENT_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);

// base64 adds a third. 3.5 MiB of file is ~4.7 MiB of JSON, which still fits MAX_BODY in
// server.js and client_max_body_size in web/nginx.conf.template (both 5 MiB). Raising this
// means raising those two first.
export const MAX_TOTAL_BYTES_CEILING = Math.floor(3.5 * 1024 * 1024);
export const MAX_BYTES_FLOOR = 100 * 1024;
export const MAX_COUNT_CEILING = 5;
// Bytes are no measure of what a PDF costs: providers read every page as text and as an image,
// so a 400 KB scan of 80 pages costs far more than a 3 MB photo. Pages are the honest limit.
// 100 is Anthropic's own ceiling per request.
export const MAX_PAGES_CEILING = 100;
export const ATTACHMENT_DEFAULTS = Object.freeze({
  maxCount: 3,
  maxBytes: 3 * 1024 * 1024,
  maxTotalBytes: MAX_TOTAL_BYTES_CEILING,
  maxPages: 30
});
const NAME_MAX = 120;

/** The admin's limits, clamped to what the transport can carry. */
export function limitsOf(cfg) {
  const a = (cfg && cfg.attachments && typeof cfg.attachments === 'object') ? cfg.attachments : {};
  const int = (v, d) => (Number.isFinite(+v) ? Math.floor(+v) : d);
  const maxCount = Math.max(0, Math.min(MAX_COUNT_CEILING, int(a.maxCount, ATTACHMENT_DEFAULTS.maxCount)));
  const maxTotalBytes = Math.max(MAX_BYTES_FLOOR, Math.min(MAX_TOTAL_BYTES_CEILING, int(a.maxTotalBytes, ATTACHMENT_DEFAULTS.maxTotalBytes)));
  const maxBytes = Math.max(MAX_BYTES_FLOOR, Math.min(maxTotalBytes, int(a.maxBytes, ATTACHMENT_DEFAULTS.maxBytes)));
  const maxPages = Math.max(1, Math.min(MAX_PAGES_CEILING, int(a.maxPages, ATTACHMENT_DEFAULTS.maxPages)));
  return { maxCount, maxBytes, maxTotalBytes, maxPages };
}

/** What GET /api/coach/status tells the client, or null when no file can be sent. */
export function capability(cfg, adapter) {
  const readable = adapter && Array.isArray(adapter.attachmentTypes) ? adapter.attachmentTypes : null;
  if (!readable) return null;
  const types = ATTACHMENT_TYPES.filter(t => readable.includes(t));
  const limits = limitsOf(cfg);
  if (!types.length || !limits.maxCount) return null;
  return { types, ...limits };
}

// What the first bytes of each accepted type look like. A declared type the bytes disagree
// with is refused: nothing downstream should have to wonder what it is holding.
const MAGIC = {
  'application/pdf': b => b.length > 4 && b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': b => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.length > 7 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/* How many pages a PDF has, roughly, without a PDF parser: page objects say `/Type /Page`
   (the page tree says `/Type /Pages`, which is not counted). A PDF 1.5+ file may keep its
   objects in compressed object streams, so when the plain text shows none those streams are
   inflated (bounded) and counted too. Returns 0 when nothing could be counted: the caller
   treats that as a refusal, not as a free pass. */
const PAGE = /\/Type\s*\/Page(?![A-Za-z])/g;
const INFLATE_MAX = 16 * 1024 * 1024;
export function countPdfPages(bytes) {
  const text = bytes.toString('latin1');
  const plain = (text.match(PAGE) || []).length;
  if (plain) return plain;
  let pages = 0, inflated = 0;
  const STREAM = /\/ObjStm[\s\S]{0,400}?stream\r?\n/g;
  let m;
  while ((m = STREAM.exec(text)) && inflated < INFLATE_MAX) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    try {
      const out = zlib.inflateSync(bytes.subarray(start, end), { maxOutputLength: INFLATE_MAX - inflated });
      inflated += out.length;
      pages += (out.toString('latin1').match(PAGE) || []).length;
    } catch { /* not deflate, cut off, or too big: counts nothing */ }
  }
  return pages;
}

/* A label for the model and the chat line. Never a path: no separators, no control characters,
   and none of the invisible ones either: a bidi override can make "fdp.exe" read as "exe.pdf",
   and zero-width characters make two names that look the same differ. */
export function cleanName(name, i) {
  const s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/^.*[\\/]/, '')
    .trim()
    .slice(0, NAME_MAX);
  return s || `attachment-${i + 1}`;
}

/**
 * Check what a client sent. Returns { ok: true, value: [{ name, mediaType, size, data }] } or
 * { ok: false, reason, status }. `cap` is the result of capability() for this instance.
 * `data` stays base64 (whitespace removed): every provider wants it that way, and the adapters in
 * ./core also run on the phone, where there is no Buffer.
 */
export function checkAttachments(raw, cap) {
  if (raw == null || (Array.isArray(raw) && !raw.length)) return { ok: true, value: [] };
  if (!cap) return { ok: false, reason: 'unsupported', status: 400 };
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed', status: 400 };
  if (raw.length > cap.maxCount) return { ok: false, reason: 'count', status: 400 };
  const out = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!a || typeof a !== 'object' || typeof a.data !== 'string' || typeof a.mediaType !== 'string') {
      return { ok: false, reason: 'malformed', status: 400 };
    }
    const mediaType = a.mediaType.trim().toLowerCase();
    if (!cap.types.includes(mediaType)) return { ok: false, reason: 'type', status: 400 };
    // Cheap size check on the encoded length first, so a huge string is not decoded to be refused.
    const data = a.data.replace(/\s+/g, '');
    if (Math.floor(data.length * 3 / 4) > cap.maxBytes + 2) return { ok: false, reason: 'size', status: 413 };
    if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, reason: 'malformed', status: 400 };
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > cap.maxBytes) return { ok: false, reason: 'size', status: 413 };
    total += bytes.length;
    if (total > cap.maxTotalBytes) return { ok: false, reason: 'total', status: 413 };
    if (!MAGIC[mediaType](bytes)) return { ok: false, reason: 'type', status: 400 };
    if (mediaType === 'application/pdf') {
      const pages = countPdfPages(bytes);
      if (!pages || pages > cap.maxPages) return { ok: false, reason: 'pages', status: 400 };
    }
    out.push({ name: cleanName(a.name, i), mediaType, size: bytes.length, data });
  }
  return { ok: true, value: out };
}

/** What the payload says about the files: names and types, never bytes. */
export const describe = list => (list || []).map(a => ({ name: a.name, mediaType: a.mediaType }));

/** File extension for a file written into a job directory. The name the user gave is not used. */
export const extFor = mediaType => ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' })[mediaType] || 'bin';
