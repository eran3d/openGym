// @vitest-environment happy-dom
// Routine folders (docs/dev/ROUTINE_FOLDERS.md): the Routines view groups by folder, a folder
// opens and closes per device, Edit reorders inside a group and moves a routine between folders.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store/useStore.js'
import Plan, { FOLDERS_CLOSED_KEY } from './Plan.jsx'

const nav = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => nav }))
vi.mock('../sheets.jsx', () => ({
  dayAssignSheet: vi.fn(), starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), menuSheet: vi.fn(),
  planHasRoutines: () => true, exportPlanFile: vi.fn(), printWholePlan: vi.fn(), importPlanFile: vi.fn(),
  folderNameSheet: vi.fn(),
}))
import { confirmSheet, folderNameSheet, menuSheet } from '../sheets.jsx'

const routine = (id, name, folder) => ({ id, name, emoji: null, ex: [{ id: '0025' }], ...(folder ? { folder } : {}) })
let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.setItem('gym_plan_view', 'routines')
  localStorage.removeItem(FOLDERS_CLOSED_KEY)
  for (const f of [confirmSheet, folderNameSheet, menuSheet]) f.mockClear()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  useStore.setState(s => ({ S: { ...s.S,
    routineFolders: [{ id: 'F', name: 'PPL' }, { id: 'G', name: 'Hotel' }],
    routines: [routine('a', 'Push', 'F'), routine('b', 'Stretch'), routine('c', 'Pull', 'F'), routine('d', 'Bands', 'G'), routine('e', 'Lost', 'gone')],
    week: {}, dayPlan: {} }, user: null }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.removeItem('gym_plan_view') })

const mount = () => act(() => root.render(<Plan />))
const lists = () => [...host.querySelectorAll('.plan-routines')].map(l => [...l.querySelectorAll('.plan-routine .tt')].map(e => e.textContent))
const folderHeads = () => [...host.querySelectorAll('.plan-folder-t')]
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const click = el => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const S = () => useStore.getState().S

describe('routine folders in Plan', () => {
  it('shows the routines in no folder first, then each folder; an unknown folder reads as none', () => {
    mount()
    expect(lists()).toEqual([['Stretch', 'Lost'], ['Push', 'Pull'], ['Bands']])
    expect(folderHeads().map(h => h.textContent)).toEqual(['PPL2', 'Hotel1'])
  })

  it('a copy without folders looks as before', () => {
    useStore.setState(s => ({ S: { ...s.S, routineFolders: [] } }))
    mount()
    expect(lists()).toEqual([['Push', 'Stretch', 'Pull', 'Bands', 'Lost']])
    expect(folderHeads()).toEqual([])
  })

  it('a folder closes and opens, remembered on this device only', () => {
    mount()
    click(folderHeads()[0])
    expect(folderHeads()[0].getAttribute('aria-expanded')).toBe('false')
    expect(lists()).toEqual([['Stretch', 'Lost'], ['Bands']])
    expect(JSON.parse(localStorage.getItem(FOLDERS_CLOSED_KEY))).toEqual(['F'])
    expect(S().routineFolders).toEqual([{ id: 'F', name: 'PPL' }, { id: 'G', name: 'Hotel' }])
    click(folderHeads()[0])
    expect(lists()[1]).toEqual(['Push', 'Pull'])
  })

  it('Edit opens every folder, so a routine in a closed one can still be moved or deleted', () => {
    localStorage.setItem(FOLDERS_CLOSED_KEY, JSON.stringify(['F', 'G', 'deleted-long-ago']))
    mount()
    expect(lists()).toEqual([['Stretch', 'Lost']])
    click(button('Edit'))
    expect(lists()).toEqual([['Stretch', 'Lost'], ['Push', 'Pull'], ['Bands']])
    expect(host.querySelector('button[aria-label="Delete Pull"]')).not.toBe(null)
    expect(folderHeads()[0].disabled).toBe(true)
    click(button('Done'))
    expect(lists()).toEqual([['Stretch', 'Lost']])
    // a toggle keeps only folders that still exist
    click(folderHeads()[0])
    expect(JSON.parse(localStorage.getItem(FOLDERS_CLOSED_KEY))).toEqual(['G'])
  })

  it('an empty folder says how to fill it, but not in Edit, where the folder button is the way', () => {
    useStore.setState(s => ({ S: { ...s.S, routines: s.S.routines.filter(r => r.folder !== 'G') } }))
    mount()
    expect(host.querySelector('.plan-folder-empty').textContent).toBe('Nothing in here yet. Move a routine in with Edit.')
    click(button('Edit'))
    expect(host.querySelector('.plan-folder-empty').textContent).toBe('Nothing in here yet.')
  })

  it('folders but no routines: the starter-plan way in stays, and the folders can still be managed', () => {
    useStore.setState(s => ({ S: { ...s.S, routines: [] } }))
    mount()
    expect(host.textContent).toContain('No routines yet.')
    expect(button('Load starter plan')).toBeTruthy()
    expect(folderHeads().map(h => h.textContent)).toEqual(['PPL0', 'Hotel0'])
    expect(host.querySelector('button[aria-label="Folder options for PPL"]')).not.toBe(null)
    expect(host.querySelector('.plan-folder-empty').textContent).toBe('Nothing in here yet.')
  })

  it('New folder is off at the cap', () => {
    useStore.setState(s => ({ S: { ...s.S, routineFolders: Array.from({ length: 50 }, (_, i) => ({ id: 'f' + i, name: 'F' + i })) } }))
    mount()
    expect(button('New folder').disabled).toBe(true)
  })

  it('Edit: the folder button moves a routine, the arrows reorder folders, a handle stays in its group', () => {
    mount()
    click(button('Edit'))
    click(host.querySelector('button[aria-label="Move Stretch to a folder"]'))
    const items = menuSheet.mock.calls[0][0].items
    expect(items.map(i => i.label)).toEqual(['Not in a folder', 'PPL', 'Hotel', 'New folder'])
    expect(items[0].on).toBe(true)
    act(() => items[2].onClick())
    expect(lists()).toEqual([['Lost'], ['Push', 'Pull'], ['Stretch', 'Bands']])
    expect(S().routines.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    click(host.querySelector('button[aria-label="Move Hotel up"]'))
    expect(S().routineFolders.map(f => f.id)).toEqual(['G', 'F'])
    // keyboard reorder inside PPL: Pull up one place, the other groups untouched
    const pull = host.querySelector('button[aria-label="Move Pull"]')
    act(() => { pull.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(S().routines.map(r => r.id)).toEqual(['c', 'b', 'a', 'd', 'e'])
  })

  it('delete asks first; the routines stay, out of the folder', () => {
    mount()
    click(host.querySelector('button[aria-label="Folder options for PPL"]'))
    const del = menuSheet.mock.calls[0][0].items.find(i => i.label === 'Delete folder')
    del.onClick()
    expect(confirmSheet).toHaveBeenCalledTimes(1)
    act(() => confirmSheet.mock.calls[0][0].onConfirm())
    expect(S().routineFolders.map(f => f.id)).toEqual(['G'])
    expect(S().routines.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(lists()).toEqual([['Push', 'Stretch', 'Pull', 'Lost'], ['Bands']])
  })

  it('New folder asks for a name and adds it', () => {
    mount()
    click(button('New folder'))
    act(() => folderNameSheet.mock.calls[0][0].onSave('Deload'))
    expect(S().routineFolders.map(f => f.name)).toEqual(['PPL', 'Hotel', 'Deload'])
    expect(host.textContent).toContain('Nothing in here yet.')
  })
})
