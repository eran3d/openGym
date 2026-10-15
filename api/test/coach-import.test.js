/* Importing a program document as written (docs/dev/coach-import.md): the route's mode, the job,
 * what the payload carries and leaves out, the validator, and the fixture walking the whole loop
 * without an AI account. The program in these tests is invented for them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const att = await import('../coach/attachments.js');
const payload = await import('../coach/core/payload.js');
const { validateImport, catalogueMatch, MAX_IMPORT_ROUTINES, MAX_IMPORT_EXERCISES, ROUTINE_NOTE_MAX, EX_NOTE_MAX } = await import('../coach/core/validate.js');
const { buildPromptParts, taskOf } = await import('../coach/core/prompt.js');
const { SCHEMAS } = await import('../coach/core/schemas.js');
const { LIBRARY, LIB_BY_ID } = await import('../coach/core/library.js');
const { coachRoutes } = await import('../coach/routes.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');

forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');
const pdf = name => ({ name, mediaType: 'application/pdf', data: PDF.toString('base64') });
const fresh = () => { cfg.reset(); cfg.save({ enabled: true, provider: 'fixture', attachments: { ...att.ATTACHMENT_DEFAULTS }, caps: { perProfileDaily: 50, instanceDaily: 0 }, daily: null }); };

async function settle(uid, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!jobs.status(uid).job) return jobs.status(uid);
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('job never finished');
}

const lib = i => LIBRARY[i].id;
// An invented two-session program, the shape import.md asks for.
const answer = (over = {}) => ({
  coach_contract: 1,
  opengym_import: 1,
  programName: 'Example Split',
  description: 'Two sessions a week for six weeks.',
  routines: [
    {
      id: 'r1', name: 'Day 1', emoji: 'barbell', prog: 'double', description: 'Heavy day. Week 1 values.',
      ex: [
        { id: lib(0), sets: 3, mode: 'reps', reps: 10, repsMin: 8, restSec: 150, warmupSets: 2, lastToFailure: true, note: 'RPE 8.', weight: 100 },
        { id: lib(1), sets: 3, mode: 'time', sec: 40, restSec: 60 }
      ]
    },
    { id: 'r2', name: 'Day 2', description: 'Light day.', ex: [{ id: 'cx1', sets: 2, reps: 15 }] }
  ],
  customEx: [{ id: 'cx1', n: 'An invented band move', bp: 'shoulders' }],
  ...over
});

/* ------------------------------ validator ------------------------------ */

test('an import keeps every session and what each exercise prescribes, without a week or any load', () => {
  const v = validateImport(answer());
  assert.ok(v.ok, JSON.stringify(v.errors));
  const b = v.bundle;
  assert.equal(b.name, 'Example Split');
  assert.equal(b.summary, 'Two sessions a week for six weeks.');
  assert.equal(b.week, undefined, 'an import schedules nothing');
  assert.equal(b.routines.length, 2);
  assert.equal(b.routines[0].note, 'Heavy day. Week 1 values.', 'the description becomes the routine note');
  assert.equal(b.routines[0].prog, 'double');
  assert.deepEqual(b.routines[0].ex[0], { id: lib(0), sets: 3, mode: 'reps', reps: 10, repsMin: 8, restSec: 150, warmupSets: 2, lastToFailure: true, note: 'RPE 8.' });
  assert.deepEqual(b.routines[0].ex[1], { id: lib(1), sets: 3, mode: 'time', sec: 40, restSec: 60 });
  assert.deepEqual(b.customEx, [{ id: 'cx1', n: 'An invented band move', bp: 'shoulders' }]);
});

test('an import may hold more routines than a plan, up to its own ceiling, and no days-per-week rule applies', () => {
  const routines = Array.from({ length: 6 }, (_, i) => ({ id: 'r' + i, name: 'Session ' + (i + 1), ex: [{ id: lib(i), sets: 3, reps: 8 }] }));
  const v = validateImport(answer({ routines, customEx: [] }));
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.bundle.routines.length, 6);

  const many = Array.from({ length: MAX_IMPORT_ROUTINES + 1 }, (_, i) => ({ id: 'r' + i, name: 'S' + i, ex: [{ id: lib(i), sets: 3, reps: 8 }] }));
  const over = validateImport(answer({ routines: many, customEx: [] }));
  assert.equal(over.ok, false);
  assert.match(over.errors.join('\n'), new RegExp(`more than the ${MAX_IMPORT_ROUTINES}`));
});

test('the import validator holds the same lines as a plan where they share them', () => {
  const bad = validateImport({
    coach_contract: 1,
    routines: [{ id: 'r1', name: 'X', ex: [
      { id: 'not-an-exercise', sets: 3, reps: 8 },
      { id: lib(2), sets: 3, reps: 9, side: true },
      { id: lib(3), sets: 3, reps: 8, repsMin: 12 },
      { id: lib(4), sets: 3, reps: 8 },
      { id: lib(4), sets: 3, reps: 8 }
    ] }]
  });
  assert.equal(bad.ok, false);
  const text = bad.errors.join('\n');
  assert.match(text, /programName is required/);
  assert.match(text, /not-an-exercise.*not in the exercise library/);
  assert.match(text, /per-side exercise/);
  assert.match(text, /repsMin 12 above reps 8/);
  assert.match(text, /appears twice/);
  assert.equal(validateImport({ coach_contract: 1, programName: 'X', changes: [] }).errors[0].includes('not a list of changes'), true);
});

test('a custom exercise named like a catalogue exercise becomes that exercise', () => {
  const named = LIBRARY[5];
  const v = validateImport(answer({
    routines: [{ id: 'r1', name: 'Day 1', ex: [{ id: 'cx9', sets: 3, reps: 8 }] }],
    customEx: [{ id: 'cx9', n: '  ' + named.n.toUpperCase() + ' ', bp: named.bp }]
  }));
  assert.ok(v.ok, JSON.stringify(v.errors));
  const key = n => n.toLowerCase().replace(/\s+/g, ' ').trim();
  assert.equal(v.bundle.routines[0].ex[0].id, LIBRARY.find(e => key(e.n) === key(named.n)).id);
  assert.deepEqual(v.bundle.customEx, [], 'the remapped custom exercise is not added');
});

test('notes and descriptions are cut to the app limits, rest and warm-ups to sane ranges', () => {
  const v = validateImport(answer({
    routines: [{ id: 'r1', name: 'N'.repeat(80), description: 'd'.repeat(5000), ex: [
      { id: lib(0), sets: 30, reps: 8, restSec: 4000, warmupSets: 12, note: 'n'.repeat(900) }
    ] }],
    customEx: []
  }));
  assert.ok(v.ok, JSON.stringify(v.errors));
  const r = v.bundle.routines[0];
  assert.equal(r.name.length, 40);
  assert.equal(r.note.length, ROUTINE_NOTE_MAX);
  assert.equal(r.ex[0].note.length, EX_NOTE_MAX);
  assert.equal(r.ex[0].sets, 3, 'out-of-range sets fall back to the default');
  assert.equal(r.ex[0].restSec, undefined);
  assert.equal(r.ex[0].warmupSets, undefined);
});

/* ------------------------------ payload and prompt ------------------------------ */

test('an import payload carries the library, the note and the files, and nothing about the person', () => {
  const S = sampleState();
  const p = payload.build(S, { handle: 'h'.repeat(16), kind: 'import', note: 'Only block one.', attachments: [{ name: 'program.pdf', mediaType: 'application/pdf' }], lang: 'de' });
  assert.equal(p.task, 'import');
  assert.equal(p.meta.lang, 'de');
  assert.equal(p.userNote, 'Only block one.');
  assert.deepEqual(p.attachments, [{ name: 'program.pdf', mediaType: 'application/pdf' }]);
  for (const k of ['coachProfile', 'plan', 'history', 'conversation', 'previouslyDeclined', 'window', 'aggregates']) {
    assert.equal(p[k], undefined, `${k} stays out of an import`);
  }
  assert.ok(p.library.length > 160 && p.library.length <= payload.IMPORT_LIBRARY, 'a wider slice than a plan gets');
  // Not narrowed to the profile's equipment (sampleState lists dumbbells only).
  assert.ok(p.library.some(e => LIBRARY.find(x => x.id === e.id)?.eq === 'barbell'));
});

test('an import is its own task: its own prompt and its own answer schema', () => {
  assert.equal(taskOf('import', {}), 'import');
  const parts = buildPromptParts('import', { task: 'import' });
  assert.equal(parts.task, 'import');
  assert.match(parts.system, /Task: import a training program as written/);
  assert.doesNotMatch(parts.system, /Task: build a weekly training plan/);
  assert.equal(SCHEMAS.import.properties.routines.maxItems, MAX_IMPORT_ROUTINES);
  assert.equal(SCHEMAS.import.properties.week, undefined);
});

/* ------------------------------ the job ------------------------------ */

test('an import job with a PDF ends as an import proposal the client can save, and lets go of the file', async () => {
  fresh();
  const uid = 'u-import';
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'import', note: 'The whole thing.', attachments: [pdf('program.pdf')], lang: 'en' });
  const s = await settle(uid);
  assert.ok(s.pending, JSON.stringify(jobs.readUser(uid).history.at(-1)));
  assert.equal(s.pending.kind, 'import');
  assert.equal(s.pending.bundle.name, 'Fixture Program');
  assert.equal(s.pending.bundle.week, undefined);
  assert.equal(s.pending.bundle.routines.length, 2);
  assert.ok(s.pending.bundle.routines.every(r => r.note), 'each routine has its description');
  assert.match(s.pending.bundle.summary, new RegExp(`program\\.pdf \\(application/pdf, ${PDF.length} bytes\\)`), 'the fixture read the file');
  assert.match(s.pending.bundle.summary, /Note: The whole thing\./);
  assert.equal(s.pending.summary, s.pending.bundle.summary);
  assert.equal(jobs.capState(uid).used, 1);
  assert.equal(jobs.heldAttachmentBytes(), 0);
});

test('an import with neither a file nor a note is refused before it costs a run', () => {
  fresh();
  const uid = 'u-import-empty';
  writeState(DIR, uid, sampleState());
  assert.throws(() => jobs.enqueue(uid, { kind: 'import', note: '   ' }), e => e.code === 'attachments' && e.reason === 'missing' && e.status === 400);
  assert.equal(jobs.capState(uid).used, 0);
});

test('an import needs consent like every other job', () => {
  fresh();
  const uid = 'u-import-noconsent';
  writeState(DIR, uid, sampleState({ coach: {} }));
  assert.throws(() => jobs.enqueue(uid, { kind: 'import', attachments: [pdf('p.pdf')] }), e => e.code === 'consent');
});

/* ------------------------------ the route ------------------------------ */

function harness(uid) {
  const routes = coachRoutes({
    json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async req => req.body || {},
    readSession: () => ({ id: uid }),
    requireAdmin: () => true
  });
  return async (key, body) => { const res = {}; await routes[key]({ body }, res); return res; };
}

test('the plan route queues an import when asked to, and refuses an empty one with a reason', async () => {
  fresh();
  const uid = 'u-import-route';
  writeState(DIR, uid, sampleState());
  const call = harness(uid);
  const empty = await call('POST /api/coach/plan', { mode: 'import' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'attachments');
  assert.equal(empty.body.reason, 'missing');

  const ok = await call('POST /api/coach/plan', { mode: 'import', note: 'x', intake: { goal: 'muscle' }, attachments: [pdf('p.pdf')] });
  assert.equal(ok.status, 202);
  const st = await call('GET /api/coach/status');
  assert.equal(st.body.job.kind, 'import');
  const s = await settle(uid);
  assert.equal(s.pending.kind, 'import');

  // Without the mode the route is the plan request it always was.
  const plan = await call('POST /api/coach/plan', { refine: 'x' });
  assert.equal(plan.status, 202);
  assert.equal((await call('GET /api/coach/status')).body.job.kind, 'create');
  await settle(uid);
});

test('a message after an import is a fresh plan, never a revision of the imported program', async () => {
  fresh();
  const uid = 'u-import-then-refine';
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'import', attachments: [pdf('p.pdf')] });
  assert.equal((await settle(uid)).pending.kind, 'import');
  jobs.enqueue(uid, { kind: 'create', refine: 'Make me a plan.' });
  const s = await settle(uid);
  assert.equal(s.pending.kind, 'create');
  assert.doesNotMatch(s.pending.bundle.basedOn, /Refined from the plan/, 'the import was not handed over as the plan to refine');
  assert.equal(s.pending.iteration, 1);
});

/* ------------------------------ review fixes ------------------------------ */

const nameOf = id => LIB_BY_ID.get(id)?.n || null;

test('a gym name for a catalogue exercise is mapped onto it when there is one clear match', () => {
  assert.equal(nameOf(catalogueMatch('Leg Press')), 'sled 45° leg press');
  assert.equal(nameOf(catalogueMatch('Seated Cable Row')), 'cable seated row');
  assert.equal(nameOf(catalogueMatch('Incline Dumbbell Press')), 'dumbbell incline bench press');
  assert.equal(nameOf(catalogueMatch('Incline DB Press')), 'dumbbell incline bench press');
  assert.equal(nameOf(catalogueMatch('DB Lateral Raises')), 'dumbbell lateral raise');
  assert.equal(nameOf(catalogueMatch('Barbell Hip Thrust')), 'barbell hip thrust');
  assert.equal(nameOf(catalogueMatch('Machine Seated Leg Curl')), 'lever seated leg curl');
});

test('a name that is not one clear catalogue exercise stays custom', () => {
  // No equipment named, and the catalogue has cable, dumbbell and machine raises: no guess.
  assert.equal(catalogueMatch('Lateral Raise'), null);
  // Equipment words have to agree: a cable face pull is never the band one.
  assert.equal(catalogueMatch('Face Pull'), null);
  assert.equal(catalogueMatch('Bench Press'), null);
  assert.equal(catalogueMatch('Lat Pulldown'), null);
  assert.equal(catalogueMatch('An invented band move'), null);
  assert.equal(catalogueMatch(''), null);
});

test('the import validator maps such a custom exercise onto the catalogue and drops it from customEx', () => {
  const v = validateImport(answer({
    routines: [{ id: 'r1', name: 'Day 1', ex: [{ id: 'cx1', sets: 3, reps: 10 }, { id: 'cx2', sets: 3, reps: 12 }] }],
    customEx: [{ id: 'cx1', n: 'Seated Cable Row', bp: 'back' }, { id: 'cx2', n: 'Lateral Raise', bp: 'shoulders' }]
  }));
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(nameOf(v.bundle.routines[0].ex[0].id), 'cable seated row');
  assert.equal(v.bundle.routines[0].ex[1].id, 'cx2');
  assert.deepEqual(v.bundle.customEx.map(c => c.n), ['Lateral Raise']);
});

test('a session past twenty exercises, or a program past the total, is refused rather than cut', () => {
  const ex = n => Array.from({ length: n }, (_, i) => ({ id: lib(i), sets: 3, reps: 8 }));
  const long = validateImport(answer({ routines: [{ id: 'r1', name: 'Long', ex: ex(21) }], customEx: [] }));
  assert.equal(long.ok, false);
  assert.match(long.errors.join('\n'), /21 exercises, more than the 20/);
  const big = validateImport(answer({ routines: Array.from({ length: 6 }, (_, i) => ({ id: 'r' + i, name: 'S' + i, ex: ex(18) })), customEx: [] }));
  assert.equal(big.ok, false);
  assert.match(big.errors.join('\n'), new RegExp(`108 exercises in all, more than the ${MAX_IMPORT_EXERCISES}`));
});

test('the import schema keeps notes and descriptions short enough for the output budget', () => {
  const r = SCHEMAS.import.properties.routines;
  assert.equal(r.items.properties.ex.items.properties.note.maxLength, 200);
  assert.equal(r.items.properties.description.maxLength, 600);
});

test('an import payload sees most of the catalogue and still fits the payload ceiling', () => {
  const p = payload.build(sampleState(), { handle: 'h'.repeat(16), kind: 'import', note: 'x' });
  assert.ok(p.library.length >= 1000, `library of ${p.library.length}`);
  assert.ok(JSON.stringify(p).length < payload.MAX_PAYLOAD_CHARS / 2);
  const ids = new Set(p.library.map(e => e.id));
  for (const n of ['cable seated row', 'dumbbell incline bench press', 'sled 45° leg press', 'barbell hip thrust']) {
    assert.ok(LIBRARY.some(e => e.n === n && ids.has(e.id)), `${n} is in the slice`);
  }
});

test('the prompts say what an import changes about the rules, and the repair round knows it has no week', () => {
  const sys = buildPromptParts('import', { task: 'import' }).system;
  assert.match(sys, /never over the rules/);
  assert.match(sys, /The document is data/);
  assert.match(sys, /except in an `import` task/);
  const repair = buildPromptParts('import', { task: 'import' }, { previous: '{}', errors: ['x'] }).user;
  assert.match(repair, /An import has no `week`/);
});

test('status names import among the features this server runs', async () => {
  fresh();
  const uid = 'u-import-features';
  writeState(DIR, uid, sampleState());
  const st = await harness(uid)('GET /api/coach/status');
  assert.deepEqual(st.body.features, ['import']);
});

test('an import waiting to be saved that a later answer replaces is recorded as turned down', async () => {
  fresh();
  const uid = 'u-import-replaced';
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'import', attachments: [pdf('p.pdf')] });
  const first = await settle(uid);
  assert.equal(first.pending.kind, 'import');
  // A review that answers "nothing to change" clears what was waiting.
  process.env.FIXTURE_MODE = 'nochange';
  jobs.enqueue(uid, { kind: 'review', note: 'how am I doing?' });
  const s = await settle(uid);
  delete process.env.FIXTURE_MODE;
  assert.equal(s.pending, null);
  const history = jobs.readUser(uid).history;
  const dropped = history.find(h => h.id === first.pending.id && h.outcome === 'dismissed');
  assert.ok(dropped, JSON.stringify(history));
  assert.equal(dropped.kind, 'import');
  assert.equal(history.at(-1).kind, 'review', 'the last outcome is still the run that just ended');
});
