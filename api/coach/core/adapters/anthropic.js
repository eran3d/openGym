/* Anthropic Messages API. */
import { httpAdapter } from './http.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';

export const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicSpec = {
  id: 'anthropic',
  path: () => '/v1/messages',
  modelsPath: '/v1/models',
  attachmentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  headers: key => ({
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    // Required for a call made from a browser context. Harmless from a server, and the phone's
    // native HTTP path does not need it either — it is here so a plain-browser dev run works.
    'anthropic-dangerous-direct-browser-access': 'true'
  }),
  // The rules block is marked cacheable: identical for every job of a task, so subsequent
  // jobs read it from Anthropic's prompt cache at a tenth of the input price.
  body: ({ model, prompt, system, maxTokens, attachments }) => ({
    model,
    max_tokens: maxTokens,
    system: system
      ? [{ type: 'text', text: SYSTEM_PROMPT + '\n\n' + system, cache_control: { type: 'ephemeral' } }]
      : SYSTEM_PROMPT,
    messages: [{ role: 'user', content: attachments && attachments.length ? [...cachedParts(attachments), { type: 'text', text: prompt }] : prompt }]
  }),
  errorMessage: data => data && data.error && data.error.message,
  readText: data => {
    if (data.stop_reason === 'refusal') return { error: 'the model declined this request' + (data.stop_details && data.stop_details.explanation ? ': ' + data.stop_details.explanation : '') };
    const text = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
    return { text, truncated: data.stop_reason === 'max_tokens' };
  },
  readModels: data => (data.data || []).map(m => m.id)
};

/** Attachments as Messages API content blocks: a PDF is a `document`, an image an `image`.
 *  Shared with the Agent SDK adapter, whose user message carries the same blocks. Files go
 *  before the text, which is the order Anthropic recommends for documents. */
export function anthropicParts(attachments) {
  return (attachments || []).map(a => ({
    type: a.mediaType === 'application/pdf' ? 'document' : 'image',
    source: { type: 'base64', media_type: a.mediaType, data: a.data },
    ...(a.mediaType === 'application/pdf' && a.name ? { title: a.name } : {})
  }));
}

/* The files with a cache breakpoint on the last one: the system block and the files are then
   one cached prefix, and the repair round (same rules, same files, different text after them)
   reads a PDF from the cache instead of paying for every page again. Two breakpoints of the four
   Anthropic allows. */
function cachedParts(attachments) {
  const parts = anthropicParts(attachments);
  if (parts.length) parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } };
  return parts;
}

export default httpAdapter(anthropicSpec);
