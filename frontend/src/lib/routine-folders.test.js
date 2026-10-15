import { describe, expect, it } from 'vitest'
import {
  addFolder, cleanFolderName, deleteFolder, folderIdOf, foldersOf, groupRoutines, moveFolder,
  moveInGroup, moveToFolder, renameFolder, FOLDER_NAME_MAX,
} from './routine-folders.js'

const r = (id, folder) => ({ id, name: id, ex: [], ...(folder ? { folder } : {}) })
const ids = xs => xs.map(x => x.id).join(',')
const state = () => ({
  routineFolders: [{ id: 'F', name: 'PPL' }, { id: 'G', name: 'Hotel' }],
  routines: [r('a', 'F'), r('b'), r('c', 'G'), r('d', 'F'), r('e', 'gone')],
})

describe('reading folders', () => {
  it('a copy without folders has every routine loose, in order', () => {
    const g = groupRoutines({ routines: [r('a'), r('b')] })
    expect(ids(g.loose)).toBe('a,b')
    expect(g.folders).toEqual([])
  })
  it('groups by folder in the order of S.routines; an unknown folder id reads as none', () => {
    const g = groupRoutines(state())
    expect(ids(g.loose)).toBe('b,e')
    expect(g.folders.map(x => [x.folder.id, ids(x.routines)])).toEqual([['F', 'a,d'], ['G', 'c']])
    expect(folderIdOf(state(), r('e', 'gone'))).toBe(null)
    expect(folderIdOf(state(), r('a', 'F'))).toBe('F')
  })
  it('skips junk entries in the folder list', () => {
    expect(foldersOf({ routineFolders: [null, 3, { name: 'x' }, { id: 'F', name: 'ok' }] }).map(f => f.id)).toEqual(['F'])
    expect(foldersOf({ routineFolders: 'nope' })).toEqual([])
  })
  it('cleans names', () => {
    expect(cleanFolderName('  Push   day ')).toBe('Push day')
    expect(cleanFolderName('x'.repeat(99))).toHaveLength(FOLDER_NAME_MAX)
    expect(cleanFolderName(null)).toBe('')
  })
})

describe('changing folders', () => {
  it('adds at the end, refuses an empty name', () => {
    const s = state()
    const f = addFolder(s, ' Deload ')
    expect(f.name).toBe('Deload')
    expect(s.routineFolders.map(x => x.id).at(-1)).toBe(f.id)
    expect(addFolder(s, '   ')).toBe(null)
    expect(addFolder({}, 'First').name).toBe('First')
  })
  it('renames', () => {
    const s = state()
    expect(renameFolder(s, 'F', 'Push Pull Legs')).toBe(true)
    expect(s.routineFolders[0].name).toBe('Push Pull Legs')
    expect(renameFolder(s, 'F', ' ')).toBe(false)
    expect(renameFolder(s, 'nope', 'x')).toBe(false)
  })
  it('deleting a folder keeps its routines, out of any folder', () => {
    const s = state()
    expect(deleteFolder(s, 'F')).toBe(true)
    expect(s.routineFolders.map(f => f.id)).toEqual(['G'])
    expect(ids(s.routines)).toBe('a,b,c,d,e')
    expect(s.routines.filter(x => 'folder' in x).map(x => x.id)).toEqual(['c', 'e'])
    expect(deleteFolder(s, 'F')).toBe(false)
  })
  it('moving to a folder changes only the field, not the place in the list', () => {
    const s = state()
    expect(moveToFolder(s, 'b', 'G')).toBe(true)
    expect(ids(s.routines)).toBe('a,b,c,d,e')
    expect(ids(groupRoutines(s).folders[1].routines)).toBe('b,c')
    expect(moveToFolder(s, 'b', 'G')).toBe(false)
    expect(moveToFolder(s, 'b', null)).toBe(true)
    expect('folder' in s.routines[1]).toBe(false)
    // a dangling id is cleared by "no folder"; a folder that does not exist means none
    expect(moveToFolder(s, 'e', null)).toBe(true)
    expect('folder' in s.routines[4]).toBe(false)
    expect(moveToFolder(s, 'a', 'nope')).toBe(true)
    expect('folder' in s.routines[0]).toBe(false)
  })
  it('reorders folders', () => {
    const s = state()
    expect(moveFolder(s, 'G', -1)).toBe(true)
    expect(s.routineFolders.map(f => f.id)).toEqual(['G', 'F'])
    expect(moveFolder(s, 'G', -1)).toBe(false)
    expect(moveFolder(s, 'F', 1)).toBe(false)
  })
  it('reorders within a group, the other groups staying put', () => {
    const s = state()
    expect(moveInGroup(s, 'F', 1, 0)).toBe(true)
    expect(ids(s.routines)).toBe('d,b,c,a,e')
    expect(moveInGroup(s, null, 0, 1)).toBe(true)
    expect(ids(s.routines)).toBe('d,e,c,a,b')
    expect(moveInGroup(s, 'G', 0, 1)).toBe(false)
    expect(moveInGroup(s, 'F', 0, 0)).toBe(false)
  })
})
