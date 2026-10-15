import { describe, it, expect } from 'vitest'
import { applyImport, revertLast, recordDismissal, CONSENT_VERSION } from './coach.js'
import { buildPlanBundle, parsePlan, mergePlan } from './plan-share.js'
import { FOLDER_MAX } from './routine-folders.js'
import { ROUTINE_NOTE_MAX } from './routines.js'
// The server's own gate, so the bundle applied here is the one a real import job hands over.
import { validateImport } from '../../../api/coach/core/validate.js'

const state = (over = {}) => ({
  unit: 'kg', customEx: [], workouts: [], exWeights: {}, dayPlan: { '2026-10-20': 'r1' },
  routines: [{ id: 'r1', name: 'Mine', ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps' }] }],
  week: { 1: ['r1'] },
  coach: { consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION }, log: [], snapshots: [] },
  ...over
})

// An invented program, run through the server's validator first.
const proposal = (over = {}) => {
  const v = validateImport({
    coach_contract: 1, opengym_import: 1,
    programName: 'Example Split', description: 'Two sessions, six weeks, a deload in week 4.',
    routines: [
      { id: 'r1', name: 'Day 1', emoji: 'barbell', prog: 'double', description: 'Heavy day. Week 1 values.',
        ex: [{ id: '0001', sets: 3, reps: 10, repsMin: 8, restSec: 150, warmupSets: 2, lastToFailure: true, note: 'RPE 8.' }] },
      { id: 'r2', name: 'Day 2', description: 'Light day.', ex: [{ id: 'cx1', sets: 2, reps: 15, note: 'Slow.' }] }
    ],
    customEx: [{ id: 'cx1', n: 'Invented band move', bp: 'shoulders', desc: 'Pull apart.' }]
  })
  if (!v.ok) throw new Error(v.errors.join('\n'))
  return { id: 'imp1', kind: 'import', summary: v.bundle.summary, bundle: v.bundle, ...over }
}
const run = (S, p = proposal()) => { const s = JSON.parse(JSON.stringify(S)); const res = applyImport(s, p); return { s, res } }

describe('applyImport', () => {
  it('files every routine of the program in one folder named after it, with its notes, and schedules nothing', () => {
    const before = state()
    const { s, res } = run(before)
    expect(res.routines).toBe(2)
    expect(s.routineFolders).toHaveLength(1)
    expect(s.routineFolders[0].name).toBe('Example Split')
    expect(res.folder).toBe(s.routineFolders[0].id)

    const added = s.routines.slice(1)
    expect(added.map(r => r.name)).toEqual(['Day 1', 'Day 2'])
    expect(added.every(r => r.folder === res.folder)).toBe(true)
    expect(added.every(r => r.id !== 'r1' && r.id !== 'r2')).toBe(true)
    expect(added[0].note).toBe('Heavy day. Week 1 values.')
    expect(added[0].prog).toBe('double')
    expect(added[0].ex[0]).toMatchObject({ id: '0001', sets: 3, reps: 10, repsMin: 8, restSec: 150, warmupSets: 2, lastToFailure: true, note: 'RPE 8.' })
    expect(added[0].ex[0].weight).toBeUndefined()

    // The custom exercise is the person's now, and the routine points at its new id.
    const cx = s.customEx.find(c => c.n === 'Invented band move')
    expect(cx).toMatchObject({ bp: 'shoulders', custom: true })
    expect(added[1].ex[0].id).toBe(cx.id)

    // Nothing that was there moves.
    expect(s.routines[0]).toEqual(before.routines[0])
    expect(s.week).toEqual(before.week)
    expect(s.dayPlan).toEqual(before.dayPlan)
  })

  it('logs the import and can be undone like a created plan; the folder stays', () => {
    const { s, res } = run(state())
    const entry = s.coach.log.at(-1)
    expect(entry).toMatchObject({ id: res.logId, kind: 'import', proposalId: 'imp1', routines: 2, folder: res.folder })
    expect(entry.bundle.name).toBe('Example Split')
    expect(entry.bundle.week).toEqual({})
    expect(s.coach.snapshots).toHaveLength(1)

    expect(revertLast(s)).toBe(true)
    expect(s.routines.map(r => r.id)).toEqual(['r1'])
    expect(s.routineFolders).toHaveLength(1)
  })

  it('reuses a folder and a custom exercise of the same name, as importing a plan file does', () => {
    const S = state({
      routineFolders: [{ id: 'f1', name: 'example  split' }],
      customEx: [{ id: 'mine', n: 'invented band move', bp: 'shoulders', custom: true }]
    })
    const { s, res } = run(S)
    expect(res.folder).toBe('f1')
    expect(s.routineFolders).toHaveLength(1)
    expect(s.customEx).toHaveLength(1)
    expect(s.routines.at(-1).ex[0].id).toBe('mine')
  })

  it('at the folder limit the routines land outside any folder, and nothing is refused', () => {
    const full = Array.from({ length: FOLDER_MAX }, (_, i) => ({ id: 'f' + i, name: 'F' + i }))
    const { s, res } = run(state({ routineFolders: full }))
    expect(res.folder).toBeNull()
    expect(s.routineFolders).toHaveLength(FOLDER_MAX)
    expect(s.routines.slice(1).every(r => r.folder === undefined)).toBe(true)
  })

  it('refuses a proposal it cannot read, and changes nothing', () => {
    const s = state()
    expect(() => applyImport(s, { id: 'x', kind: 'import', bundle: { name: 'X', routines: [] } })).toThrow()
    expect(() => applyImport(s, { id: 'x', kind: 'import', bundle: { name: 'X', routines: [{ name: 'A', ex: [] }] } })).toThrow()
    expect(s.routines).toHaveLength(1)
    expect(s.coach.snapshots).toHaveLength(0)
  })

  it('a turned-down import is logged as an import and is not a review', () => {
    const s = state()
    recordDismissal(s, proposal())
    expect(s.coach.log.at(-1)).toMatchObject({ kind: 'import', dismissed: true })
    expect(s.coach.lastReview).toBeUndefined()
  })
})

describe('a routine note', () => {
  it('travels in a plan file, trimmed and bounded', () => {
    const S = state({ routines: [{ id: 'r1', name: 'Mine', note: '  ' + 'n'.repeat(ROUTINE_NOTE_MAX + 50), ex: [{ id: '0001', sets: 3, reps: 10 }] }, { id: 'r2', name: 'Bare', note: '   ', ex: [{ id: '0001', sets: 3, reps: 10 }] }] })
    const file = buildPlanBundle(S, 'P')
    expect(file.routines[0].note).toHaveLength(ROUTINE_NOTE_MAX)
    expect('note' in file.routines[1]).toBe(false)
    const target = state({ routines: [] })
    mergePlan(target, parsePlan(JSON.stringify(file)))
    expect(target.routines[0].note).toHaveLength(ROUTINE_NOTE_MAX)
    expect('note' in target.routines[1]).toBe(false)
  })
})
