/* Routine folders: how Plan groups the routines (docs/dev/ROUTINE_FOLDERS.md).
 *
 *   S.routineFolders = [{ id, name }]   the folders, in the order Plan shows them
 *   S.routines[i].folder = '<id>'       the folder a routine is in; absent = none
 *
 * A routine whose `folder` names no folder in the list (deleted on another device, not synced
 * yet, or never set) is not in a folder: it is shown with the others, never hidden. The order
 * inside a folder is the order of S.routines, so every other screen keeps one order.
 *
 * The writers below change a store draft in place (call them inside store.update); the store
 * stamps what they changed (lib/sync-merge.js stampChange).
 */
import { uid } from './format.js'

export const FOLDER_NAME_MAX = 40

const list = v => (Array.isArray(v) ? v : [])

/** The folders of a copy that can be shown: entries with an id, in their order. */
export const foldersOf = S => list(S?.routineFolders).filter(f => f && typeof f === 'object' && f.id != null)

/** A typed name made fit to keep: trimmed, inner runs of spaces folded, capped. */
export const cleanFolderName = name => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX)

/** The id of the folder `r` is in, or null when it is in none that exists. */
export function folderIdOf(S, r) {
  const id = r?.folder
  if (id == null || id === '') return null
  return foldersOf(S).some(f => f.id === id) ? id : null
}

/**
 * The routines as Plan groups them: `loose` are the routines in no folder, `folders` each folder
 * with its routines, both in the order of S.routines.
 */
export function groupRoutines(S) {
  const folders = foldersOf(S)
  const by = new Map(folders.map(f => [f.id, []]))
  const loose = []
  for (const r of list(S?.routines)) {
    if (!r) continue
    const id = r.folder
    if (id != null && by.has(id)) by.get(id).push(r); else loose.push(r)
  }
  return { loose, folders: folders.map(folder => ({ folder, routines: by.get(folder.id) })) }
}

/** Adds a folder at the end and returns it, or null for an empty name. */
export function addFolder(s, name) {
  const n = cleanFolderName(name)
  if (!n) return null
  const folder = { id: uid(), name: n }
  s.routineFolders = [...foldersOf(s), folder]
  return folder
}

export function renameFolder(s, id, name) {
  const n = cleanFolderName(name)
  const f = foldersOf(s).find(x => x.id === id)
  if (!f || !n || f.name === n) return false
  s.routineFolders = foldersOf(s).map(x => (x.id === id ? { ...x, name: n } : x))
  return true
}

/**
 * Deletes a folder. Its routines stay and are taken out of it: their `folder` is cleared, so no
 * copy is left pointing at a folder that is gone (readers would ignore it anyway, folderIdOf).
 */
export function deleteFolder(s, id) {
  if (!foldersOf(s).some(f => f.id === id)) return false
  s.routineFolders = foldersOf(s).filter(f => f.id !== id)
  s.routines = list(s.routines).map(r => {
    if (r?.folder !== id) return r
    const { folder: _gone, ...rest } = r
    return rest
  })
  return true
}

/**
 * Puts a routine in a folder, or in none (`folderId` null). Only its `folder` field changes, not
 * its place in S.routines: a move is then one field of one routine, and never collides with a
 * reorder made on another device.
 */
export function moveToFolder(s, routineId, folderId) {
  const target = folderId != null && foldersOf(s).some(f => f.id === folderId) ? folderId : null
  let changed = false
  s.routines = list(s.routines).map(r => {
    if (r?.id !== routineId) return r
    const cur = folderIdOf(s, r)
    if (cur === target && (target != null || r.folder == null)) return r
    changed = true
    if (target == null) { const { folder: _gone, ...rest } = r; return rest }
    return { ...r, folder: target }
  })
  return changed
}

/** Moves a folder one place up (`dir` -1) or down (+1) in the list. */
export function moveFolder(s, id, dir) {
  const fs = foldersOf(s)
  const i = fs.findIndex(f => f.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= fs.length) return false
  const next = fs.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  s.routineFolders = next
  return true
}

/**
 * Reorders inside one group (`folderId`, or null for the routines in no folder): the group's
 * routine at index `from` goes to index `to` of the group, and S.routines moves it to the matching
 * place, every routine of the other groups staying where it is.
 */
export function moveInGroup(s, folderId, from, to) {
  const rs = list(s.routines)
  const inGroup = r => (folderIdOf(s, r) ?? null) === (folderId ?? null)
  const at = rs.map((r, i) => (r && inGroup(r) ? i : -1)).filter(i => i >= 0)
  if (from === to || from < 0 || to < 0 || from >= at.length || to >= at.length) return false
  const group = at.map(i => rs[i])
  const [m] = group.splice(from, 1)
  group.splice(to, 0, m)
  const next = rs.slice()
  at.forEach((i, k) => { next[i] = group[k] })
  s.routines = next
  return true
}
