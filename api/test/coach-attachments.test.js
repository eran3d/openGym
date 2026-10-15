/* Files attached to a plan request (docs/dev/coach-attachments.md): what is accepted, what each
 * provider is handed, and that the bytes are gone when the job is. The fixture provider walks the
 * whole path without an AI account: it reads the files from its job directory and echoes their
 * names and sizes, so a test can tell bytes that arrived from a payload that only describes them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const att = await import('../coach/attachments.js');
const { coachRoutes } = await import('../coach/routes.js');
const { adapterFor } = await import('../coach/adapters/index.js');
const { anthropicSpec } = await import('../coach/core/adapters/anthropic.js');
const { openaiSpec } = await import('../coach/core/adapters/openai.js');
const { geminiSpec } = await import('../coach/core/adapters/gemini.js');
const { compatibleSpec } = await import('../coach/core/adapters/compatible.js');
const { LOCKDOWN, promptFor } = await import('../coach/adapters/claude.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');

forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });

import zlib from 'node:zlib';

/** A PDF skeleton with `n` page objects, as plain objects or packed in a compressed object stream. */
const pdfWith = (n, { packed = false } = {}) => {
  const pages = Array.from({ length: n }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join('');
  const head = '%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ' + n + ' >> endobj\n';
  if (!packed) return Buffer.from(head + pages + 'trailer << >>\n%%EOF\n', 'latin1');
  const body = zlib.deflateSync(Buffer.from(pages, 'latin1'));
  return Buffer.concat([
    Buffer.from(head + `9 0 obj << /Type /ObjStm /N ${n} /First 0 /Filter /FlateDecode /Length ${body.length} >>\nstream\n`, 'latin1'),
    body, Buffer.from('\nendstream endobj\ntrailer << >>\n%%EOF\n', 'latin1')
  ]);
};
const PDF = pdfWith(2);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const b64 = buf => buf.toString('base64');
const file = (name, mediaType, buf) => ({ name, mediaType, data: b64(buf) });
const ALL = att.capability({}, adapterFor('fixture'));

const fresh = (patch = {}) => { cfg.reset(); cfg.save({ enabled: true, provider: 'fixture', attachments: { ...att.ATTACHMENT_DEFAULTS }, caps: { perProfileDaily: 50, instanceDaily: 0 }, daily: null, ...patch }); };

async function settle(uid, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!jobs.status(uid).job) return jobs.status(uid);
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('job never finished');
}

/* ------------------------------ the check ------------------------------ */

test('a PDF, a PNG and a JPEG whose bytes match their type are accepted, decoded once and sized', () => {
  const r = att.checkAttachments([file('plan.pdf', 'application/pdf', PDF), file('a.png', 'image/png', PNG), file('b.jpg', 'IMAGE/JPEG', JPEG)], ALL);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map(a => [a.name, a.mediaType, a.size]), [
    ['plan.pdf', 'application/pdf', PDF.length], ['a.png', 'image/png', PNG.length], ['b.jpg', 'image/jpeg', JPEG.length]
  ]);
  assert.equal(r.value[0].data, b64(PDF), 'base64 is what every provider wants, so it stays base64');
  assert.deepEqual(att.checkAttachments(undefined, null), { ok: true, value: [] }, 'no attachments needs no capability');
  assert.deepEqual(att.checkAttachments([], null), { ok: true, value: [] });
});

test('each way a file can be wrong is refused with its own reason, before anything is decoded twice', () => {
  const reason = (list, cap = ALL) => att.checkAttachments(list, cap).reason;
  assert.equal(reason([file('p.pdf', 'application/pdf', PDF)], null), 'unsupported');
  assert.equal(reason('not a list'), 'malformed');
  assert.equal(reason([{ name: 'x' }]), 'malformed');
  assert.equal(reason([{ name: 'x', mediaType: 'application/pdf', data: '%%%not base64%%%' }]), 'malformed');
  assert.equal(reason([file('x.gif', 'image/gif', PNG)]), 'type', 'not on the whitelist');
  assert.equal(reason([file('x.pdf', 'application/pdf', PNG)]), 'type', 'a PNG claiming to be a PDF');
  assert.equal(reason([file('x.png', 'image/png', Buffer.from('<html>'))]), 'type');
  assert.equal(reason([file('x.pdf', 'application/pdf', pdfWith(31))]), 'pages', 'over the default 30 pages');
  assert.equal(reason([file('x.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'))]), 'pages', 'no page to count is a refusal, not a free pass');
  assert.equal(reason(Array(4).fill(file('p.pdf', 'application/pdf', PDF))), 'count');
  const small = { ...ALL, maxBytes: 200 * 1024, maxTotalBytes: 300 * 1024 };
  assert.equal(att.checkAttachments([file('x.pdf', 'application/pdf', pdfWith(31))], small).status, 400);
  const big = Buffer.concat([PDF, Buffer.alloc(250 * 1024)]);
  const r = att.checkAttachments([file('big.pdf', 'application/pdf', big)], small);
  assert.equal(r.reason, 'size'); assert.equal(r.status, 413);
  const mid = Buffer.concat([PDF, Buffer.alloc(180 * 1024)]);
  assert.equal(reason([file('a.pdf', 'application/pdf', mid), file('b.pdf', 'application/pdf', mid)], small), 'total');
});

test('a name is a label: path parts and control characters are dropped, and a missing one gets a default', () => {
  assert.equal(att.cleanName('../../etc/passwd', 0), 'passwd');
  assert.equal(att.cleanName('C:\\Users\\me\\plan.pdf', 0), 'plan.pdf');
  assert.equal(att.cleanName('a\u0000b\nc.pdf', 0), 'abc.pdf');
  assert.equal(att.cleanName('', 2), 'attachment-3');
  assert.equal(att.cleanName('x'.repeat(300), 0).length, 120);
  assert.equal(att.cleanName('plan\u202Efdp.exe', 0), 'planfdp.exe', 'a right-to-left override cannot dress an .exe up as a .pdf');
  assert.equal(att.cleanName('pl\u200Ban\uFEFF.pdf\u2066', 0), 'plan.pdf', 'zero-width and isolate characters are gone');
  assert.equal(att.cleanName('\u200B\u200F', 1), 'attachment-2');
});

test('pages are counted on page objects, never the page tree, and inside compressed object streams too', () => {
  assert.equal(att.countPdfPages(pdfWith(1)), 1);
  assert.equal(att.countPdfPages(pdfWith(12)), 12, '/Type /Pages is not a page');
  assert.equal(att.countPdfPages(pdfWith(7, { packed: true })), 7);
  assert.equal(att.countPdfPages(Buffer.from('%PDF-1.4 /Type/Page /Type /PageLabel')), 1);
  const cap = { ...ALL, maxPages: 5 };
  assert.equal(att.checkAttachments([file('a.pdf', 'application/pdf', pdfWith(5, { packed: true }))], cap).ok, true);
  assert.equal(att.checkAttachments([file('a.pdf', 'application/pdf', pdfWith(6, { packed: true }))], cap).reason, 'pages');
});

test('limits are clamped to what one request body can carry, and 0 files switches the feature off', () => {
  assert.deepEqual(att.limitsOf({}), { ...att.ATTACHMENT_DEFAULTS });
  const l = att.limitsOf({ attachments: { maxCount: 99, maxBytes: 1e9, maxTotalBytes: 1e9 } });
  assert.equal(l.maxCount, att.MAX_COUNT_CEILING);
  assert.equal(l.maxTotalBytes, att.MAX_TOTAL_BYTES_CEILING);
  assert.ok(l.maxBytes <= l.maxTotalBytes);
  // base64 of the ceiling, plus room for the rest of the request, fits the plan route's body
  // limit, and that limit is the nginx one (see the template test below).
  assert.equal(att.MAX_TOTAL_BYTES_CEILING, 15 * 1024 * 1024);
  assert.ok(Math.ceil(att.MAX_TOTAL_BYTES_CEILING / 3) * 4 + 512 * 1024 < att.PLAN_BODY_LIMIT);
  assert.equal(att.ATTACHMENT_DEFAULTS.maxBytes, 10 * 1024 * 1024);
  assert.equal(att.ATTACHMENT_DEFAULTS.maxTotalBytes, 15 * 1024 * 1024);
  assert.equal(att.capability({ attachments: { maxCount: 0 } }, adapterFor('fixture')), null);
});

test('an image is held to what the provider takes per image, a PDF to the file limit', () => {
  const cap = att.capability({}, adapterFor('anthropic'));
  assert.equal(cap.maxImageBytes, 7500000, 'Anthropic: 10 MB of base64 per image');
  assert.equal(att.capability({}, adapterFor('claude')).maxImageBytes, 7500000);
  assert.equal(att.capability({}, adapterFor('openai')).maxImageBytes, cap.maxBytes);
  const bigPng = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]);
  const r = att.checkAttachments([file('big.png', 'image/png', bigPng)], cap);
  assert.equal(r.reason, 'size'); assert.equal(r.status, 413);
  assert.equal(att.checkAttachments([file('big.png', 'image/png', bigPng)], att.capability({}, adapterFor('openai'))).ok, true);
  const bigPdf = Buffer.concat([pdfWith(3), Buffer.alloc(8 * 1024 * 1024)]);
  assert.equal(att.checkAttachments([file('big.pdf', 'application/pdf', bigPdf)], cap).ok, true, 'a PDF is not an image');
});

test('which providers read files is stated by each adapter, and nothing else decides it', () => {
  for (const id of ['fixture', 'claude', 'anthropic', 'openai', 'gemini']) {
    assert.deepEqual(att.capability({}, adapterFor(id)).types, ['application/pdf', 'image/jpeg', 'image/png'], id);
  }
  for (const id of ['codex', 'compatible']) assert.equal(att.capability({}, adapterFor(id)), null, id);
});

/* ------------------------------ per provider ------------------------------ */

const sent = [{ name: 'plan.pdf', mediaType: 'application/pdf', size: PDF.length, data: b64(PDF) }, { name: 'a.png', mediaType: 'image/png', size: PNG.length, data: b64(PNG) }];

test('Anthropic gets document and image blocks ahead of the text; without files the body is unchanged', () => {
  const body = anthropicSpec.body({ model: 'm', prompt: 'P', system: 'S', maxTokens: 10, attachments: sent });
  const c = body.messages[0].content;
  assert.deepEqual(c[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(PDF) }, title: 'plan.pdf' });
  // The last file closes the cached prefix (system + files), so the repair round reads them from
  // the cache. Two breakpoints in all, within Anthropic's four.
  assert.deepEqual(c[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(PNG) }, cache_control: { type: 'ephemeral' } });
  const marks = JSON.stringify(body).match(/cache_control/g).length;
  assert.equal(marks, 2);
  assert.deepEqual(c[2], { type: 'text', text: 'P' });
  assert.equal(anthropicSpec.body({ model: 'm', prompt: 'P', system: 'S', maxTokens: 10, attachments: [] }).messages[0].content, 'P');
});

test('OpenAI gets a file part for a PDF and a data URL for an image; Gemini gets inline parts', () => {
  const c = openaiSpec.body({ model: 'm', prompt: 'P', system: 'S', maxTokens: 10, attachments: sent }).messages[1].content;
  assert.deepEqual(c[0], { type: 'file', file: { filename: 'plan.pdf', file_data: `data:application/pdf;base64,${b64(PDF)}` } });
  assert.deepEqual(c[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${b64(PNG)}` } });
  assert.deepEqual(c[2], { type: 'text', text: 'P' });
  const parts = geminiSpec.body({ prompt: 'P', system: 'S', maxTokens: 10, attachments: sent }).contents[0].parts;
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'application/pdf', data: b64(PDF) } });
  assert.deepEqual(parts.at(-1), { text: 'P' });
  assert.equal(compatibleSpec.attachmentTypes, null);
});

test('an adapter that cannot read a file fails the call instead of sending the request without it', async () => {
  let called = false;
  const fetch = async () => { called = true; return new Response('{}'); };
  const r = await adapterFor('compatible').invoke({ cfg: { providerOptions: { compatible: { baseUrl: 'http://127.0.0.1:1' } } }, prompt: 'P', model: 'm', env: {}, fetch, attachments: sent });
  assert.equal(r.code, 1);
  assert.equal(called, false);
  const codex = await adapterFor('codex').invoke({ prompt: 'P', attachments: sent, env: {}, timeoutMs: 1000 });
  assert.equal(codex.code, 1);
});

test('the Agent SDK gets the files as content blocks on a user message, and keeps every tool switched off', async () => {
  assert.deepEqual(LOCKDOWN.tools, [], 'no Read tool to open a file with');
  assert.equal(promptFor('P', []), 'P');
  const msgs = [];
  for await (const m of promptFor('P', sent)) msgs.push(m);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'user');
  assert.equal(msgs[0].parent_tool_use_id, null);
  assert.deepEqual(msgs[0].message.content.map(b => b.type), ['document', 'image', 'text']);
});

test('the repair round sends the files again, the same ones', async () => {
  const { runPipeline } = await import('../coach/core/pipeline.js');
  const calls = [];
  const adapter = { spawns: false, invoke: async o => { calls.push(o.attachments); return { code: 0, text: 'not json at all' }; } };
  const files = [...sent];
  const r = await runPipeline({ adapter, cfg: {}, kind: 'create', payload: { library: [] }, timeoutMs: 1000, invokeOpts: { attachments: files } });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2, 'one attempt and one repair round');
  assert.deepEqual(calls[1], sent);
});

/* ------------------------------ through the queue ------------------------------ */

test('a refine with a PDF reaches the provider as a file, and nothing of it is left behind', async () => {
  fresh();
  const uid = 'u-attach';
  writeState(DIR, uid, sampleState());
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('coach-'));
  jobs.enqueue(uid, { kind: 'create', refine: 'Make this my plan.', attachments: [file('trainer plan.pdf', 'application/pdf', PDF)] });
  const s = await settle(uid);
  assert.ok(s.pending, JSON.stringify(jobs.readUser(uid).history.at(-1)));
  assert.match(s.pending.summary, new RegExp(`trainer plan\\.pdf \\(application/pdf, ${PDF.length} bytes\\)`), 'the fixture read the bytes from its job directory');
  assert.equal(jobs.capState(uid).used, 1, 'one job, one run off the cap');

  // Privacy: the bytes are in no file under ./data and no job directory survives the job.
  const needle = b64(PDF).slice(0, 40);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(DIR)) {
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!body.includes(needle), `${f} holds the attachment`);
    assert.ok(!body.includes('%PDF-'), `${f} holds the attachment`);
  }
  assert.ok(!JSON.stringify(cfg.load().log).includes('trainer plan'), 'the instance log names no file');
  const tmpAfter = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('coach-'));
  assert.deepEqual(tmpAfter.filter(f => !tmpBefore.includes(f)), [], 'the job directory is removed');
  assert.equal(jobs.heldAttachmentBytes(), 0, 'and the process holds no bytes once the job is done');
});

test('a job that ends before the provider is called lets go of its files as well', async () => {
  fresh();
  const uid = 'u-attach-nostate';
  // Two jobs take both slots, so this one waits in the queue, and its state is gone by the time
  // it runs: it returns before a provider is called.
  for (const other of ['u-attach-busy1', 'u-attach-busy2']) { writeState(DIR, other, sampleState()); jobs.enqueue(other, { kind: 'review' }); }
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'create', refine: 'x', attachments: [file('p.pdf', 'application/pdf', PDF)] });
  assert.equal(jobs.status(uid).job.state, 'queued');
  fs.unlinkSync(path.join(DIR, `state-${uid}.json`));
  await settle(uid);
  await settle('u-attach-busy1'); await settle('u-attach-busy2');
  assert.equal(jobs.readUser(uid).history.at(-1).errorClass, 'nostate');
  assert.equal(jobs.heldAttachmentBytes(), 0);
});

test('forgetting a profile mid-job lets go of its files at once', async () => {
  fresh();
  const uid = 'u-attach-forget';
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'create', refine: 'x', attachments: [file('p.pdf', 'application/pdf', PDF)] });
  assert.equal(jobs.heldAttachmentBytes(), PDF.length);
  jobs.clearUser(uid);
  assert.equal(jobs.heldAttachmentBytes(), 0);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(jobs.readUser(uid).pending, null, 'and the forgotten job writes nothing back');
});

test('a refused attachment costs no run, and only a plan request takes one', () => {
  fresh();
  const uid = 'u-attach-refused';
  writeState(DIR, uid, sampleState());
  assert.throws(() => jobs.enqueue(uid, { kind: 'create', refine: 'x', attachments: [file('x.pdf', 'application/pdf', PNG)] }),
    e => e.code === 'attachments' && e.reason === 'type' && e.status === 400);
  assert.throws(() => jobs.enqueue(uid, { kind: 'review', attachments: [file('x.pdf', 'application/pdf', PDF)] }),
    e => e.code === 'attachments' && e.reason === 'unsupported');
  assert.equal(jobs.capState(uid).used, 0);
  cfg.save({ provider: 'codex' });
  assert.equal(jobs.attachmentsFor(), null);
  fresh();
});

/* ------------------------------ the routes ------------------------------ */

function harness(uid) {
  const routes = coachRoutes({
    json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async req => req.body || {},
    readSession: () => ({ id: uid, admin: true }),
    requireAdmin: () => true
  });
  return async (key, body) => { const res = {}; await routes[key]({ body }, res); return res; };
}

test('status tells the client what it may attach; the plan route refuses with a reason it can translate', async () => {
  fresh();
  const uid = 'u-attach-routes';
  writeState(DIR, uid, sampleState());
  const call = harness(uid);
  const st = await call('GET /api/coach/status');
  assert.deepEqual(st.body.attachments, { types: ['application/pdf', 'image/jpeg', 'image/png'], ...att.ATTACHMENT_DEFAULTS, maxImageBytes: att.ATTACHMENT_DEFAULTS.maxBytes });
  assert.equal(st.body.attachments.maxPages, 30);

  const bad = await call('POST /api/coach/plan', { refine: 'x', attachments: [file('x.png', 'image/png', PDF)] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'attachments');
  assert.equal(bad.body.reason, 'type');

  const ok = await call('POST /api/coach/plan', { refine: 'x', attachments: [file('x.png', 'image/png', PNG)] });
  assert.equal(ok.status, 202);
  await settle(uid);
});

test('the admin sets the limits within the ceilings, and the card says whether the provider can read files', async () => {
  fresh();
  const call = harness('admin-1');
  let r = await call('POST /api/admin/coach/config', { attachments: { maxCount: 1, maxBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxPages: 10 } });
  assert.equal(r.status, 200);
  r = await call('GET /api/admin/coach');
  assert.deepEqual(r.body.attachments, { maxCount: 1, maxBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxPages: 10, supported: true });
  await call('POST /api/admin/coach/config', { attachments: { maxCount: 50, maxBytes: 1e12, maxPages: 5000 } });
  r = await call('GET /api/admin/coach');
  assert.equal(r.body.attachments.maxCount, att.MAX_COUNT_CEILING);
  assert.equal(r.body.attachments.maxPages, att.MAX_PAGES_CEILING);
  assert.equal(r.body.attachments.maxBytes, 2 * 1024 * 1024, 'a file is never allowed to be bigger than the whole request');
  assert.equal((await call('POST /api/admin/coach/config', { attachments: 'lots' })).status, 400);
  await call('POST /api/admin/coach/config', { provider: 'codex' });
  assert.equal((await call('GET /api/admin/coach')).body.attachments.supported, false);
  fresh();
});

/* ------------------------------ the transport ------------------------------ */

test('nginx gives the plan route, and only that route, the body the API accepts there', () => {
  const tpl = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web', 'nginx.conf.template'), 'utf8');
  const block = tpl.match(/location = \$\{BASE_PATH\}\/api\/coach\/plan \{([\s\S]*?)\n {4}\}/);
  assert.ok(block, 'an exact-match location for /api/coach/plan');
  const m = block[1].match(/client_max_body_size (\d+)m;/);
  assert.ok(m);
  assert.equal(+m[1] * 1024 * 1024, att.PLAN_BODY_LIMIT, 'nginx and the API agree on the plan route');
  assert.match(block[1], /proxy_pass \$api_upstream\$api_request_uri;/);
  const api = tpl.match(/location \^~ \$\{BASE_PATH\}\/api\/ \{([\s\S]*?)\n {4}\}/);
  assert.match(api[1], /client_max_body_size 5m;/, 'every other API route keeps 5 MiB');
  assert.equal((tpl.match(/client_max_body_size/g) || []).length, 3, 'api, plan, media: nothing else');
});
