/* Routine folders on the server (docs/dev/ROUTINE_FOLDERS.md): `routineFolders` is an entry list
   with tombstones and an order stamp, `folder` an ordinary field of a routine. A writer that does
   not stamp gets its folder changes stamped, and one that knows no folders cannot drop them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampPut, highestStamp } from '../sync-stamps.js';

const T = 1_800_000_000_000;
const clone = v => JSON.parse(JSON.stringify(v));
const doc = () => ({
  _ts: T, unit: 'kg', workouts: [], edited: { restSec: T },
  routineFolders: [{ id: 'F', name: 'PPL', _ts: T - 10 }, { id: 'G', name: 'Hotel', _ts: T - 10 }],
  routines: [{ id: 'a', name: 'A', ex: [], folder: 'F', _ts: T - 10 }, { id: 'b', name: 'B', ex: [], _ts: T - 10 }],
});

test('a folder removed by an API client is tombstoned; a new one gets its _ts', () => {
  const cur = doc();
  const next = clone(cur);
  next.routineFolders = [next.routineFolders[1], { id: 'H', name: 'New' }];
  stampPut(cur, next, { overRead: true, now: T + 100 });
  assert.ok(next.deleted.routineFolders.F >= T + 100);
  assert.ok(next.routineFolders[1]._ts >= T + 100);
  assert.equal(next.edited.routineFolders, undefined);
});

test('a routine moved by an API client is stamped per field', () => {
  const cur = doc();
  const next = clone(cur);
  next.routines[1].folder = 'G';
  stampPut(cur, next, { overRead: true, now: T + 100 });
  assert.ok(next.routines[1]._f.folder >= T + 100);
});

test('a folder reorder is stamped as routineFolderOrder', () => {
  const cur = doc();
  const next = clone(cur);
  next.routineFolders.reverse();
  stampPut(cur, next, { overRead: true, now: T + 100 });
  assert.ok(next.edited.routineFolderOrder >= T + 100);
  assert.equal(next.edited.routineOrder, undefined);
});

test('a writer that knows no folders keeps them', () => {
  const cur = doc();
  const next = clone(cur);
  delete next.routineFolders;
  delete next.routines[0].folder;
  delete next.edited;
  stampPut(cur, next, { overRead: true, now: T + 100 });
  assert.deepEqual(next.routineFolders.map(f => f.id), ['F', 'G']);
  assert.equal(next.routines[0].folder, 'F');
});

test('folder stamps count towards the highest stamp', () => {
  const d = doc();
  d.routineFolders[0]._f = { name: T + 500 };
  assert.equal(highestStamp(d), T + 500);
});

/* An app from before folders that stamps its own changes (v1.4.x web, `stamped: true`): its merge
   after a 409 takes `routineFolders` whole from its own newer copy and keeps no
   `deleted.routineFolders`. The server merges the folders itself (stampPut step 2b). */
const stored = () => {
  const d = doc();
  d.routineFolders = [{ id: 'F', name: 'PPL v2', _ts: T + 100, _f: { name: T + 100 } }, { id: 'G', name: 'Hotel', _ts: T + 100 }];
  d.routines[1] = { ...d.routines[1], folder: 'G', _ts: T + 100, _f: { folder: T + 100 } };
  d.edited = { restSec: T, routineFolderOrder: T + 100 };
  return d;
};

test('a v1.4 push keeps a rename and a new folder made on an updated app', () => {
  const cur = stored();
  // its whole copy of the list, from before both changes
  const next = { ...clone(cur), routineFolders: [{ id: 'F', name: 'PPL', _ts: T - 10 }], edited: { restSec: T + 200 } };
  next.routines[0].name = 'Push day';
  const report = {};
  stampPut(cur, next, { overRead: true, stamped: true, now: T + 300, report });
  assert.deepEqual(next.routineFolders.map(f => f.name), ['PPL v2', 'Hotel']);
  assert.equal(next.routines[0].name, 'Push day');
  assert.equal(report.changed, true);   // its next check of the revision reads the result
});

test('a v1.4 push cannot bring a deleted folder back', () => {
  const cur = doc();
  cur.routineFolders = [cur.routineFolders[1]];
  cur.routines[0] = { ...cur.routines[0], _f: { folder: T + 100 } }; delete cur.routines[0].folder;
  cur.deleted = { routineFolders: { F: T + 100 } };
  const next = clone(doc());   // still has F, and no record of its removal
  delete next.deleted;
  next.routines[0] = { ...cur.routines[0], name: 'Push day', _ts: T + 200 };
  stampPut(cur, next, { overRead: true, stamped: true, now: T + 300 });
  assert.deepEqual(next.routineFolders.map(f => f.id), ['G']);
  assert.ok(next.deleted.routineFolders.F > 0, 'still a removal, not an add-back');
});

test('an updated app\'s own changes go through unchanged, removal and reorder included', () => {
  const cur = doc();
  const next = clone(cur);
  next.routineFolders = [{ id: 'H', name: 'New', _ts: T + 50 }, { ...cur.routineFolders[1], name: 'Travel', _ts: T + 50, _f: { name: T + 50 } }];
  next.deleted = { routineFolders: { F: T + 50 } };
  next.edited = { ...cur.edited, routineFolderOrder: T + 50 };
  const want = clone(next.routineFolders);
  const report = {};
  stampPut(cur, next, { overRead: true, stamped: true, now: T + 60, report });
  assert.deepEqual(next.routineFolders, want);
  assert.equal(report.changed, undefined);
});

test('a writer whose order of the folders is older gets the stored order, its new folder beside its neighbour', () => {
  const cur = stored();
  cur.routineFolders.reverse();             // G, F: reordered at T + 100
  const next = clone(cur);
  next.routineFolders = [cur.routineFolders[1], cur.routineFolders[0], { id: 'H', name: 'Mine', _ts: T + 150 }];
  next.edited = { restSec: T, routineFolderOrder: T };
  stampPut(cur, next, { overRead: true, stamped: true, now: T + 200 });
  assert.deepEqual(next.routineFolders.map(f => f.id), ['G', 'H', 'F']);
});

test('the same reset: names a writer from before folders dropped come back', () => {
  const cur = doc();
  cur.resetAt = T - 5; cur.resetIds = { routines: ['x'], routineFolders: ['old1', 'old2'] };
  const next = clone(cur);
  next.resetIds = { routines: ['x', 'y'] };
  stampPut(cur, next, { overRead: true, stamped: true, now: T + 10 });
  assert.deepEqual(next.resetIds.routineFolders, ['old1', 'old2']);
  assert.deepEqual(next.resetIds.routines, ['x', 'y']);
  // a new reset starts its own record
  const fresh = { ...clone(cur), resetAt: T + 1, resetIds: { routines: ['z'] } };
  stampPut(cur, fresh, { stamped: true, now: T + 20 });
  assert.equal(fresh.resetIds.routineFolders, undefined);
});
