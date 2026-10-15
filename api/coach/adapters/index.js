/* Provider adapters. Everything above this layer speaks one interface:
 *
 *   check(cfg, env)                                  → { ok, version?, error? }
 *   invoke({ prompt, jobDir, env, model, timeoutMs, attachments? })
 *                                                    → { code, text, stderr, timedOut, spawnError }
 *   spawns                                             true when a job runs a child process
 *   attachmentTypes                                    media types it reads as files, or null
 *
 * `spawns` decides whether the privilege drop is required before a job may run. The three
 * runtime-backed adapters say true; the HTTPS ones in ../core/adapters say false, because a
 * fetch has no process to drop privileges on and must not be refused for lacking one.
 *
 * Adding a provider is a file here plus a row in config.PROVIDERS. Nothing else in the
 * codebase — routes, jobs, payload, validation, UI — knows which one is configured.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, unprivilegedIds } from './spawn.js';
import { extFor } from '../attachments.js';
import claude from './claude.js';
import codex from './codex.js';
import anthropic from '../core/adapters/anthropic.js';
import openai from '../core/adapters/openai.js';
import gemini from '../core/adapters/gemini.js';
import compatible from '../core/adapters/compatible.js';

/**
 * The in-repo fake provider. Ships with the image on purpose: it is what CI drives, and it
 * lets an instance owner see the entire Coach loop — intake, proposal, apply, revert —
 * before deciding whether to connect a real account to it.
 */
const FIXTURE = new URL('../fixture-cli.mjs', import.meta.url).pathname;
const fixture = {
  id: 'fixture',
  spawns: true,
  cli: process.execPath,
  // Takes every type, so the whole attachment path can be walked without an AI account. The
  // files go where a runtime that reads from disk would find them: the job directory, under
  // names this module picks (never the user's), removed with the directory when the job ends.
  attachmentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  async check() { return { ok: true, version: 'fixture' }; },
  async invoke({ prompt, jobDir, env, timeoutMs, attachments }) {
    if (attachments && attachments.length && jobDir) {
      // Owned by the unprivileged user where there is one, like everything else in a job
      // directory: removeJobDir has that user clear the contents, and a root-owned 0700 directory
      // in there is one it could not. Recursive and overwriting, because the repair round calls
      // this a second time for the same job.
      const ids = unprivilegedIds();
      const dir = path.join(jobDir, 'attachments');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (ids) fs.chownSync(dir, ids.uid, ids.gid);
      attachments.forEach((a, i) => {
        const file = path.join(dir, `${i + 1}.${extFor(a.mediaType)}`);
        fs.writeFileSync(file, Buffer.from(a.data, 'base64'), { mode: 0o600 });
        if (ids) fs.chownSync(file, ids.uid, ids.gid);
      });
    }
    const r = await run(process.execPath, [FIXTURE], {
      stdin: prompt, cwd: jobDir, timeoutMs,
      // The fixture needs its mode knob, which the sanitised job env deliberately drops.
      env: { ...env, FIXTURE_MODE: process.env.FIXTURE_MODE || '' },
      asCoach: false   // a temp dir owned by root in tests; the fixture reads only stdin anyway
    });
    return { ...r, text: (r.stdout || '').trim() };
  }
};

/* claude is registered unconditionally, and that is safe because claude.js imports the SDK
   lazily: on the default image the module loads, check() reports the runtime as absent, and
   isConnected() keeps the Coach out of /api/config entirely. Codex is here too, and unlike
   the SDK its runtime is a CLI binary, so its absence shows up as a spawn error from check(). */
const ADAPTERS = { fixture, claude, codex, anthropic, openai, gemini, compatible };
export const adapterFor = provider => ADAPTERS[provider] || null;
export default ADAPTERS;
