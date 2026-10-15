// Files picked in the Coach chat, checked against what the server said it takes
// (GET /api/coach/status → attachments) before a byte is read or sent. The server checks again;
// this is so a person picking a 20 MB photo hears it at once, not after an upload.

import { t } from './i18n.js'
import { fmtMB } from './media-limits.js'

/**
 * Can `picked` be added to `current`? Both are lists of { name, type|mediaType, size }.
 * Returns { ok: true } or { ok: false, reason } with the server's own reason names.
 */
export function checkPicked(current, picked, cap) {
  if (!cap) return { ok: false, reason: 'unsupported' }
  const all = [...(current || []), ...(picked || [])]
  if (all.length > cap.maxCount) return { ok: false, reason: 'count' }
  let total = 0
  for (const f of picked || []) {
    const type = String(f.type || f.mediaType || '').toLowerCase()
    if (!cap.types.includes(type)) return { ok: false, reason: 'type' }
    if (!(f.size > 0)) return { ok: false, reason: 'malformed' }
    if (f.size > cap.maxBytes) return { ok: false, reason: 'size' }
  }
  for (const f of all) total += f.size || 0
  if (total > cap.maxTotalBytes) return { ok: false, reason: 'total' }
  return { ok: true }
}

/** Bytes to base64 without a data: prefix, in chunks so a 3 MB file does not blow the stack. */
export function toBase64(bytes) {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

/** A picked File as the request wants it. */
export async function readAttachment(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { name: file.name, mediaType: String(file.type).toLowerCase(), size: bytes.length, data: toBase64(bytes) }
}

/** What the file picker offers: the types the server listed. */
export const acceptOf = cap => (cap?.types || []).join(',')

// Why a file was refused, in the app's voice. Getters, like JOB_ERRORS, so a language picked
// after this module loaded still reaches them.
export const ATTACHMENT_ERRORS = {
  get unsupported() { return t('The Coach can’t read files on this instance.') },
  get malformed() { return t('That file couldn’t be read.') },
  get type() { return t('The Coach reads PDFs and JPEG or PNG images.') },
  get count() { return t('That’s more files than the Coach takes at once.') },
  get size() { return t('That file is too big for the Coach.') },
  get total() { return t('Together these files are too big for the Coach.') },
  get pages() { return t('That PDF has more pages than the Coach reads.') }
}

/** The line shown for a refusal, with the limit that was crossed where there is one. */
export function attachmentErrorText(reason, cap) {
  const base = ATTACHMENT_ERRORS[reason] || ATTACHMENT_ERRORS.malformed
  if (!cap) return base
  if (reason === 'size') return base + ' ' + t('Up to {0} MB per file.', fmtMB(cap.maxBytes / 1048576))
  if (reason === 'total') return base + ' ' + t('Up to {0} MB in all.', fmtMB(cap.maxTotalBytes / 1048576))
  if (reason === 'count') return base + ' ' + t('Up to {0} at a time.', cap.maxCount)
  if (reason === 'pages' && cap.maxPages) return base + ' ' + t('Up to {0} pages.', cap.maxPages)
  return base
}
