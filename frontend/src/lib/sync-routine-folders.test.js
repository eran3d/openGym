/* Routine folders across devices (docs/dev/ROUTINE_FOLDERS.md): a routine's folder is one field of
   the routine, the folders are an entry list with tombstones and an order stamp of their own. The
   server (api/sync-stamps.js) stamps them the same way for a writer that does not. */
import { describe, expect, it } from 'vitest'
import { highestStamp, mergeStates, resetIdsOf, sinceReset, stampChange, stampReplace, stampRestore } from './sync-merge.js'
import { addFolder, deleteFolder, groupRoutines, moveFolder, moveToFolder, renameFolder } from './routine-folders.js'
import * as S from '../../../api/sync-stamps.js'

const clone = v => JSON.parse(JSON.stringify(v))
const T = 1_800_000_000_000
const r = (id, folder) => ({ id, name: id, ex: [], _ts: T - 1000, ...(folder ? { folder } : {}) })
const base = () => ({
  _ts: T, unit: 'kg', workouts: [], edited: { restSec: T },
  routineFolders: [{ id: 'F', name: 'PPL', _ts: T - 1000 }, { id: 'G', name: 'Hotel', _ts: T - 1000 }],
  routines: [r('a', 'F'), r('b'), r('c', 'G')],
})
const change = (prev, fn, wall) => { const n = clone(prev); fn(n); n._ts = stampChange(prev, n, wall); return n }
const both = (A, B) => [mergeStates(A, B), mergeStates(B, A)]
const folderOf = (s, id) => s.routines.find(x => x.id === id)?.folder
const groups = s => { const g = groupRoutines(s); return [g.loose.map(x => x.id).join(','), ...g.folders.map(x => `${x.folder.name}:${x.routines.map(y => y.id).join(',')}`)] }

describe('stamps', () => {
  it('a move stamps the routine field, a new folder its _ts, a rename its name', () => {
    const A = change(base(), s => { moveToFolder(s, 'b', 'F'); renameFolder(s, 'G', 'Travel'); addFolder(s, 'Deload') }, T + 1000)
    const b = A.routines.find(x => x.id === 'b'), g = A.routineFolders.find(x => x.id === 'G')
    expect(b._f.folder).toBe(A._ts)
    expect(g._f.name).toBe(A._ts)
    expect(A.routineFolders.at(-1)._ts).toBe(A._ts)
    expect(A.edited.routineFolders).toBeUndefined()
    expect(A.edited.routineFolderOrder).toBeUndefined()
    expect(highestStamp(A)).toBe(A._ts)
    expect(S.highestStamp(A)).toBe(highestStamp(A))
  })
  it('a delete tombstones the folder and clears the field of its routines', () => {
    const A = change(base(), s => { deleteFolder(s, 'F') }, T + 1000)
    expect(A.deleted.routineFolders.F).toBe(A._ts)
    expect(folderOf(A, 'a')).toBeUndefined()
    expect(A.routines.find(x => x.id === 'a')._f.folder).toBe(A._ts)
  })
  it('a reorder of the folders stamps edited.routineFolderOrder, not routineOrder', () => {
    const A = change(base(), s => { moveFolder(s, 'G', -1) }, T + 1000)
    expect(A.edited.routineFolderOrder).toBe(A._ts)
    expect(A.edited.routineOrder).toBeUndefined()
  })
})

describe('two devices', () => {
  it('rename on one, routine moved into the same folder on the other: both stay', () => {
    const web = change(base(), s => { renameFolder(s, 'F', 'Push Pull Legs') }, T + 1000)
    const phone = change(base(), s => { moveToFolder(s, 'b', 'F') }, T + 2000)
    for (const m of both(web, phone)) expect(groups(m)).toEqual(['', 'Push Pull Legs:a,b', 'Hotel:c'])
  })
  it('the same folder renamed twice: the later name', () => {
    const A = change(base(), s => { renameFolder(s, 'F', 'One') }, T + 1000)
    const B = change(base(), s => { renameFolder(s, 'F', 'Two') }, T + 2000)
    for (const m of both(A, B)) expect(m.routineFolders[0].name).toBe('Two')
  })
  it('folder deleted on one, a routine moved into it later on the other: the routine stays, out of a folder', () => {
    const A = change(base(), s => { deleteFolder(s, 'F') }, T + 1000)
    const B = change(base(), s => { moveToFolder(s, 'b', 'F') }, T + 2000)
    for (const m of both(A, B)) {
      expect(m.routineFolders.map(f => f.id)).toEqual(['G'])
      expect(m.routines.map(x => x.id)).toEqual(['a', 'b', 'c'])
      expect(groups(m)).toEqual(['a,b', 'Hotel:c'])
    }
  })
  it('folder deleted after the other moved a routine into it: the routine stays, out of a folder', () => {
    const B = change(base(), s => { moveToFolder(s, 'b', 'F') }, T + 1000)
    const A = change(base(), s => { deleteFolder(s, 'F') }, T + 2000)
    for (const m of both(A, B)) {
      expect(m.routines.map(x => x.id)).toEqual(['a', 'b', 'c'])
      expect(groups(m)).toEqual(['a,b', 'Hotel:c'])
    }
  })
  it('folder deleted on one, renamed later on the other: the folder stays', () => {
    const A = change(base(), s => { deleteFolder(s, 'F') }, T + 1000)
    const B = change(base(), s => { renameFolder(s, 'F', 'Kept') }, T + 2000)
    for (const m of both(A, B)) {
      expect(m.routineFolders.map(f => f.name)).toEqual(['Kept', 'Hotel'])
      expect(groups(m)).toEqual(['a,b', 'Kept:', 'Hotel:c'])
    }
  })
  it('a routine moved to different folders: the later move', () => {
    const A = change(base(), s => { moveToFolder(s, 'b', 'F') }, T + 1000)
    const B = change(base(), s => { moveToFolder(s, 'b', 'G') }, T + 2000)
    for (const m of both(A, B)) expect(folderOf(m, 'b')).toBe('G')
  })
  it('a move survives a later rename of the same routine on the other device', () => {
    const A = change(base(), s => { moveToFolder(s, 'b', 'G') }, T + 1000)
    const B = change(base(), s => { s.routines[1].name = 'Bench' }, T + 2000)
    for (const m of both(A, B)) {
      const b = m.routines.find(x => x.id === 'b')
      expect([b.name, b.folder]).toEqual(['Bench', 'G'])
    }
  })
  it('folder order: the reorder made last wins, an unrelated later change does not undo it', () => {
    const A = change(base(), s => { moveFolder(s, 'G', -1) }, T + 1000)
    const B = change(base(), s => { s.restSec = 45 }, T + 5000)
    for (const m of both(A, B)) expect(m.routineFolders.map(f => f.id)).toEqual(['G', 'F'])
  })
  it('folders made on each device both arrive, each next to its neighbour', () => {
    const A = change(base(), s => { addFolder(s, 'A-new') }, T + 1000)
    const B = change(base(), s => { addFolder(s, 'B-new') }, T + 2000)
    for (const m of both(A, B)) expect(m.routineFolders.map(f => f.name).sort()).toEqual(['A-new', 'B-new', 'Hotel', 'PPL'])
  })
  it('a copy that never had folders keeps the other\'s, and its routines keep their folder', () => {
    const old = { _ts: T + 9000, unit: 'kg', workouts: [], routines: [{ id: 'a', name: 'a', ex: [], _ts: T - 1000, folder: 'F' }, r('b'), r('c', 'G')] }
    for (const m of both(base(), old)) expect(groups(m)).toEqual(['b', 'PPL:a', 'Hotel:c'])
  })
  it('sign-in (prefer) keeps the preferred side\'s folders as they are', () => {
    const server = change(base(), s => { renameFolder(s, 'F', 'Server') }, T + 1000)
    const guest = change(base(), s => { renameFolder(s, 'F', 'Guest') }, T + 2000)
    expect(mergeStates(guest, server, { prefer: 'b' }).routineFolders[0].name).toBe('Server')
  })
})

describe('reset, restore and replace', () => {
  it('a reset names the folders, and a copy that missed it loses them', () => {
    const ids = resetIdsOf(base())
    expect(ids.routineFolders).toEqual(['F', 'G'])
    expect(sinceReset(base(), T + 1, ids).routineFolders).toEqual([])
    expect(sinceReset(base(), T - 2000, null).routineFolders.map(f => f.id)).toEqual(['F', 'G'])
  })
  it('a restored backup brings a deleted folder back, and its order wins', () => {
    const now = change(base(), s => { deleteFolder(s, 'F') }, T + 1000)
    const backup = stampRestore(clone(base()), [now], T + 2000)
    expect(backup.deleted.routineFolders.F).toBe(-(T + 2000))
    expect(backup.edited.routineFolderOrder).toBe(T + 2000)
    expect(mergeStates(now, backup).routineFolders.map(f => f.id)).toEqual(['F', 'G'])
  })
  it('a replace stamps folders it renames', () => {
    const backup = clone(base()); backup.routineFolders[0].name = 'Old name'
    stampReplace(backup, [base()], T + 3000)
    expect(backup.routineFolders[0]._f.name).toBe(T + 3000)
  })
})

describe('the server, for a writer that does not stamp', () => {
  it('a folder an API client removed is tombstoned, one it renamed stamped per field', () => {
    const cur = base()
    const next = clone(cur); next.routineFolders = [{ ...next.routineFolders[1], name: 'Travel' }]
    S.stampPut(cur, next, { overRead: true, now: T + 3000 })
    expect(next.deleted.routineFolders.F).toBeGreaterThanOrEqual(T + 3000)
    expect(next.routineFolders[0]._f.name).toBeGreaterThanOrEqual(T + 3000)
  })
  it('its reorder of the folders is stamped; an older copy\'s order is put back', () => {
    const cur = base()
    const next = clone(cur); next.routineFolders.reverse()
    S.stampPut(cur, next, { overRead: true, now: T + 3000 })
    expect(next.edited.routineFolderOrder).toBeGreaterThanOrEqual(T + 3000)
    const later = change(base(), s => { moveFolder(s, 'G', -1) }, T + 4000)
    const stale = clone(base()); stale.edited.routineFolderOrder = T - 5000
    stale.routineFolders = [stale.routineFolders[0], stale.routineFolders[1]]
    stale.routineFolders.push({ id: 'H', name: 'mine' })
    S.stampPut(later, stale, { overRead: true, now: T + 5000 })
    expect(stale.routineFolders.map(f => f.id)).toEqual(['G', 'H', 'F'])   // H after its neighbour G, as for routines
  })
  it('an older app that knows no folders keeps them: the list and a routine\'s field come back', () => {
    const cur = base()
    const old = clone(cur); delete old.routineFolders; delete old.routines[0].folder; delete old.edited
    old.routines[0].name = 'A renamed'
    S.stampPut(cur, old, { overRead: true, now: T + 3000 })
    expect(old.routineFolders.map(f => f.id)).toEqual(['F', 'G'])
    expect(old.routines[0].folder).toBe('F')
  })
})
