import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CoachChat from './CoachChat.jsx'
import { refinePlan, importProgram, resolvePending, requestReview } from '../lib/coach-api.js'
import { confirmSheet } from '../sheets.jsx'
import { CONSENT_VERSION } from '../lib/coach.js'   // the consent a fixture grants is the current one, whatever its number

// Importing a program (docs/dev/coach-import.md): a picked file can be sent as a plan request or
// as an import, the import's proposal is shown with its descriptions and notes, and saving it
// files the routines in a folder without touching the week.
const mocks = vi.hoisted(() => {
  const state = { S: null, pending: null, job: null, community: false, maxMessageLen: 2200, attachments: null, features: ['import'], nav: vi.fn(), toast: vi.fn(), openSheet: vi.fn(), refresh: vi.fn() }
  state.storeSnapshot = () => ({
    S: state.S,
    user: { id: 'u1' },
    ready: true,
    config: { coach: { enabled: true, ...(state.community ? { community: true } : {}) } },
    coachLocal: null,
    update: mut => mut(state.S),
  })
  state.uiSnapshot = () => ({ toast: state.toast, openSheet: state.openSheet })
  return state
})

vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector(mocks.storeSnapshot())
  useStore.getState = mocks.storeSnapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const useUI = selector => selector ? selector(mocks.uiSnapshot()) : mocks.uiSnapshot()
  useUI.getState = mocks.uiSnapshot
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../lib/coach-api.js', () => ({
  useCoachStatus: () => ({ pending: mocks.pending, job: mocks.job, cap: null, loading: false, lastError: null, last: null, refresh: mocks.refresh, maxMessageLen: mocks.maxMessageLen, attachments: mocks.attachments, features: mocks.features }),
  resolvePending: vi.fn(() => Promise.resolve({})),
  refinePlan: vi.fn(() => Promise.resolve({})),
  importProgram: vi.fn(() => Promise.resolve({})),
  requestReview: vi.fn(() => Promise.resolve({})),
  requestDebrief: vi.fn(() => Promise.resolve({})),
  cohortStats: vi.fn(() => Promise.resolve({ ok: false, enabled: true, sharing: false })),
  setCohortShare: vi.fn(() => Promise.resolve({ ok: true, sharing: true })),
  JOB_ERRORS: { internal: 'x' },
  awaitedJob: () => null,
  settleAwaited: vi.fn(),
}))
vi.mock('../sheets.jsx', () => ({ startFlow: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.resolve({})),
  IS_APPLE: false, IS_ANDROID: false, BIO: 'biometrics',
}))
vi.mock('../coach.css', () => ({}))

let dom, root, container


const state = () => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {},
  dayPlan: {}, routines: [], week: {},
  coach: {
    consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION },
    profile: { goal: 'muscle', experience: 'new', daysPerWeek: 3, sessionMin: 60, preferredDays: [1, 3, 5], equipment: [] },
    log: [], snapshots: [], chat: [{ id: 'c1', role: 'user', kind: 'intake', at: 1 }], timings: []
  },
})

function installDom() {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  dom = parsed.window
  globalThis.window = dom
  globalThis.document = dom.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event', 'Blob']) globalThis[key] = dom[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.getElementById('root')
  root = createRoot(container)
}

async function mount(pending, job = null, { community = false, S = state() } = {}) {
  mocks.S = S
  mocks.pending = pending
  mocks.job = job
  mocks.community = community
  installDom()
  await act(async () => { root.render(React.createElement(CoachChat)) })
}

const byText = re => [...container.querySelectorAll('button')].find(b => re.test(b.textContent || ''))
async function click(el) {
  expect(el).toBeTruthy()
  await act(async () => { el.dispatchEvent(new dom.Event('click', { bubbles: true })) })
}

beforeEach(() => { vi.clearAllMocks(); mocks.features = ['import'] })
afterEach(async () => {
  if (root) { await act(async () => { root.unmount() }); root = null }
  container = null; dom = null
})

const CAP = { types: ['application/pdf', 'image/jpeg', 'image/png'], maxCount: 2, maxBytes: 1024, maxTotalBytes: 2048 }
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

async function pick(files) {
  const input = container.querySelector('input[type="file"]')
  expect(input).toBeTruthy()
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => { input.dispatchEvent(new dom.Event('change', { bubbles: true })) })
  // reading the file is a promise of its own
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

const importProposal = () => ({
  id: 'imp1', kind: 'import', summary: 'Two sessions, six weeks.',
  bundle: {
    opengym_plan: 1, name: 'Example Split', summary: 'Two sessions, six weeks.',
    routines: [
      { id: 'r1', name: 'Day 1', emoji: 'barbell', note: 'Heavy day. Week 1 values.', ex: [{ id: '0001', sets: 3, mode: 'reps', reps: 10, repsMin: 8, restSec: 150, warmupSets: 2, note: 'RPE 8.' }] },
      { id: 'r2', name: 'Day 2', note: 'Light day.', ex: [{ id: 'cx1', sets: 2, mode: 'reps', reps: 15 }] }
    ],
    customEx: [{ id: 'cx1', n: 'Invented band move', bp: 'shoulders' }]
  }
})

describe('importing a program in the Coach chat', () => {
  it('offers plan or import for a picked file, and sends an import as one', async () => {
    mocks.attachments = CAP
    await mount(null)
    expect(container.querySelector('.attach-mode')).toBeNull()
    await pick([new File([PDF], 'program.pdf', { type: 'application/pdf' })])
    expect(container.querySelector('.attach-mode')).toBeTruthy()
    await click(byText(/Import to library/))
    await click(container.querySelector('.send'))
    expect(refinePlan).not.toHaveBeenCalled()
    expect(importProgram).toHaveBeenCalledTimes(1)
    const [note, files] = importProgram.mock.calls[0]
    expect(note).toBe('')
    expect(files.map(f => f.name)).toEqual(['program.pdf'])
    const line = mocks.S.coach.chat.at(-1)
    expect(line.text).toBe('Import this program into my library.')
    expect(line.files).toEqual(['program.pdf'])
    expect(container.querySelector('.attach-mode')).toBeNull()
  })

  it('keeps a picked file a plan request unless import is chosen', async () => {
    mocks.attachments = CAP
    await mount(null)
    await pick([new File([PDF], 'plan.pdf', { type: 'application/pdf' })])
    await click(container.querySelector('.send'))
    expect(importProgram).not.toHaveBeenCalled()
    expect(refinePlan).toHaveBeenCalledTimes(1)
  })

  it('asks before an import takes the place of a plan that is waiting', async () => {
    mocks.attachments = CAP
    await mount({ id: 'p1', kind: 'create', bundle: { routines: [{ id: 'r1', name: 'A', ex: [{ id: '0001', sets: 3, reps: 8 }] }], week: {} } })
    await pick([new File([PDF], 'program.pdf', { type: 'application/pdf' })])
    await click(byText(/Import to library/))
    await click(container.querySelector('.send'))
    expect(importProgram).not.toHaveBeenCalled()
    const opts = confirmSheet.mock.calls[0][0]
    expect(opts.title).toMatch(/Replace what the Coach proposed/)
    await act(async () => { await opts.onConfirm() })
    expect(importProgram).toHaveBeenCalledTimes(1)
  })

  it('shows the program with its descriptions and notes, and saves it into a folder without scheduling', async () => {
    mocks.attachments = CAP
    const S = state()
    await mount(importProposal(), null, { S })
    const card = container.querySelector('[data-testid="import-card"]')
    expect(card).toBeTruthy()
    const text = card.textContent
    expect(text).toContain('Example Split')
    expect(text).toContain('Heavy day. Week 1 values.')
    expect(text).toContain('RPE 8.')
    expect(text).toContain('Warm-up sets: 2')
    expect(text).not.toMatch(/weekly schedule/i)
    await click(byText(/Day 2/))
    expect(container.querySelector('[data-testid="import-card"]').textContent).toContain('Invented band move')

    await click(byText(/Save to library/))
    expect(S.routines.map(r => r.name)).toEqual(['Day 1', 'Day 2'])
    expect(S.routineFolders.map(f => f.name)).toEqual(['Example Split'])
    expect(S.routines.every(r => r.folder === S.routineFolders[0].id)).toBe(true)
    expect(S.week).toEqual({})
    const line = S.coach.chat.at(-1)
    expect(line.kind).toBe('applied')
    expect(line.text).toContain('“Example Split”')
    expect(S.coach.log.at(-1).kind).toBe('import')
    expect(resolvePending).toHaveBeenCalledWith({ accepted: ['import'] })
  })

  it('offers no import where the server does not list it', async () => {
    mocks.attachments = CAP
    mocks.features = undefined
    await mount(null)
    await pick([new File([PDF], 'program.pdf', { type: 'application/pdf' })])
    expect(container.querySelector('.attach-mode')).toBeNull()
    await click(container.querySelector('.send'))
    expect(importProgram).not.toHaveBeenCalled()
    expect(refinePlan).toHaveBeenCalledTimes(1)
  })

  it('puts the choice back to a plan request once the picked file is removed', async () => {
    mocks.attachments = CAP
    await mount(null)
    await pick([new File([PDF], 'program.pdf', { type: 'application/pdf' })])
    await click(byText(/Import to library/))
    await click(container.querySelector('.attach-x'))
    expect(container.querySelector('.attach-mode')).toBeNull()
    await pick([new File([PDF], 'plan.pdf', { type: 'application/pdf' })])
    await click(container.querySelector('.send'))
    expect(importProgram).not.toHaveBeenCalled()
    expect(refinePlan).toHaveBeenCalledTimes(1)
  })

  it('asks before a message takes the place of a program waiting, and records it as turned down', async () => {
    mocks.attachments = CAP
    const S = state()
    await mount(importProposal(), null, { S })
    // The question comes before anything is sent, whatever the message is: here a plan request
    // with a file (a typed message takes the same first branch of send()).
    await pick([new File([PDF], 'plan.pdf', { type: 'application/pdf' })])
    await click(container.querySelector('.send'))
    expect(refinePlan).not.toHaveBeenCalled()
    expect(requestReview).not.toHaveBeenCalled()
    const opts = confirmSheet.mock.calls.at(-1)[0]
    expect(opts.title).toMatch(/Replace the program waiting/)
    await act(async () => { await opts.onConfirm() })
    expect(refinePlan).toHaveBeenCalledTimes(1)
    expect(S.coach.log.at(-1)).toMatchObject({ kind: 'import', proposalId: 'imp1', dismissed: true })
    expect(S.coach.chat.some(m => m.kind === 'dismissed')).toBe(true)
  })
})
