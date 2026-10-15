/* A routine's description (`routines[].note`, docs/dev/coach-import.md) is an ordinary field of a
   routine entry: a writer that does not know it (v1.3.9, an API client) cannot drop it, a change
   it does make is stamped per field, and an app that stamps its own changes carries it through. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampPut } from '../sync-stamps.js';

const T = 1_800_000_000_000;
const clone = v => JSON.parse(JSON.stringify(v));
const doc = () => ({
  _ts: T, unit: 'kg', workouts: [], edited: { restSec: T },
  routineFolders: [{ id: 'F', name: 'Example Split', _ts: T - 10 }],
  routines: [{ id: 'a', name: 'Day 1', note: 'Heavy day. Week 1 values.', folder: 'F', ex: [{ id: '0001', sets: 3, reps: 8 }], _ts: T - 10 }]
});

test('a v1.3.9 push that knows no routine note keeps it', () => {
  const cur = doc();
  const next = clone(cur);
  delete next.routines[0].note;
  delete next.edited;
  next.routines[0].name = 'Day one';
  stampPut(cur, next, { overRead: true, now: T + 100 });
  assert.equal(next.routines[0].note, 'Heavy day. Week 1 values.');
  assert.equal(next.routines[0].name, 'Day one');
});

test('a routine note changed by a writer that does not stamp is stamped per field', () => {
  const cur = doc();
  const next = clone(cur);
  next.routines[0].note = 'Heavy day. Deload in week 4.';
  stampPut(cur, next, { overRead: true, now: T + 100 });
  assert.equal(next.routines[0].note, 'Heavy day. Deload in week 4.');
  assert.ok(next.routines[0]._f.note >= T + 100);
});

test('a v1.4 push that stamps its own changes carries the routine note through', () => {
  const cur = doc();
  const next = { ...clone(cur), edited: { restSec: T + 200 } };
  next.routines[0] = { ...next.routines[0], name: 'Day 1 (heavy)', _ts: T + 200, _f: { name: T + 200 } };
  stampPut(cur, next, { overRead: true, stamped: true, now: T + 300 });
  assert.equal(next.routines[0].note, 'Heavy day. Week 1 values.');
  assert.equal(next.routines[0].name, 'Day 1 (heavy)');
});
