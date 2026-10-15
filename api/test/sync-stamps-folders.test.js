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
