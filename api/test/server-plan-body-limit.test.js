/* The plan route reads a bigger body than any other route, because it may carry files
   (coach/attachments.js PLAN_BODY_LIMIT). Every other route keeps MAX_BODY. Real server.js in a
   child, with the Coach switched on, so the plan route actually gets as far as reading. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const { PLAN_BODY_LIMIT } = await import('../coach/attachments.js');
const MAX_BODY = 5 * 1024 * 1024;

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-planbody-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_plan_1', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }));
  fs.writeFileSync(path.join(dataDir, 'coach.json'), JSON.stringify({ enabled: true, provider: 'fixture' }), { mode: 0o600 });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => log);
  return { api: `http://127.0.0.1:${port}`, cookie: `gymsid=${mintSession('u_plan_1')}` };
}

const post = (h, p, bytes, method = 'POST') => fetch(h.api + p, {
  method,
  headers: { cookie: h.cookie, 'content-type': 'application/json' },
  // A refine with padding: valid JSON of exactly the size asked for.
  body: '{"refine":"x","pad":"' + 'a'.repeat(bytes - 26) + '"}'
});

test('the plan route reads a body past 5 MiB, up to its own limit, and refuses past that', async t => {
  const h = await startServer(t);
  assert.ok(PLAN_BODY_LIMIT > 20 * 1024 * 1024);
  const big = await post(h, '/api/coach/plan', 12 * 1024 * 1024);
  assert.notEqual(big.status, 413, 'read in full: whatever it answers, it is not "body too large"');
  const over = await post(h, '/api/coach/plan', PLAN_BODY_LIMIT + 1024);
  assert.equal(over.status, 413);
  assert.deepEqual(await over.json(), { error: 'body too large' });
});

test('every other route keeps the 5 MiB cap', async t => {
  const h = await startServer(t);
  for (const [p, method] of [['/api/data', 'PUT'], ['/api/coach/review', 'POST']]) {
    const r = await post(h, p, MAX_BODY + 1024, method);
    assert.equal(r.status, 413, p);
  }
});
