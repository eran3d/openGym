import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CoachChat from './CoachChat.jsx'
import { refinePlan } from '../lib/coach-api.js'
import { confirmSheet } from '../sheets.jsx'
import { CONSENT_VERSION } from '../lib/coach.js'   // the consent a fixture grants is the current one, whatever its number

// Attaching a file to a message (docs/dev/coach-attachments.md): the paperclip shows only when
// the server's status lists attachment support, a picked file is checked against those limits
// before it is read, and sending hands the file to refinePlan while the chat keeps only its name.
const mocks = vi.hoisted(() => {
  const state = { S: null, pending: null, job: null, community: false, maxMessageLen: 2200, attachments: null, nav: vi.fn(), toast: vi.fn(), openSheet: vi.fn(), refresh: vi.fn() }
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
  useCoachStatus: () => ({ pending: mocks.pending, job: mocks.job, cap: null, loading: false, lastError: null, last: null, refresh: mocks.refresh, maxMessageLen: mocks.maxMessageLen, attachments: mocks.attachments }),
  resolvePending: vi.fn(() => Promise.resolve({})),
  refinePlan: vi.fn(() => Promise.resolve({})),
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

beforeEach(() => { vi.clearAllMocks() })
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

describe('attachments in the Coach chat', () => {
  it('shows no paperclip when the server does not take files', async () => {
    mocks.attachments = null
    await mount(null)
    expect(container.querySelector('.attach')).toBeNull()
    expect(container.querySelector('input[type="file"]')).toBeNull()
  })

  it('sends a picked PDF as a plan request and keeps only its name in the thread', async () => {
    mocks.attachments = CAP
    await mount(null)
    expect(container.querySelector('input[type="file"]').getAttribute('accept')).toBe('application/pdf,image/jpeg,image/png')
    await pick([new File([PDF], 'trainer plan.pdf', { type: 'application/pdf' })])
    expect(container.querySelector('.attach-chip').textContent).toContain('trainer plan.pdf')
    const send = container.querySelector('.send')
    expect(send.disabled).toBe(false)
    await click(send)
    expect(refinePlan).toHaveBeenCalledTimes(1)
    const [text, files] = refinePlan.mock.calls[0]
    expect(text).toBe('Build my plan from the attached file.')
    expect(files).toEqual([{ name: 'trainer plan.pdf', mediaType: 'application/pdf', size: PDF.length, data: 'JVBERi0xLjQ=' }])
    const line = mocks.S.coach.chat.at(-1)
    expect(line.files).toEqual(['trainer plan.pdf'])
    expect(JSON.stringify(mocks.S)).not.toContain('JVBERi0')
    expect(container.querySelector('.attach-chip')).toBeNull()
  })

  it('refuses a file over the limit before reading it, and says why', async () => {
    mocks.attachments = CAP
    await mount(null)
    await pick([new File([new Uint8Array(2000)], 'big.pdf', { type: 'application/pdf' })])
    expect(container.querySelector('.attach-chip')).toBeNull()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/too big/))
    await pick([new File([PDF], 'notes.txt', { type: 'text/plain' })])
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.stringMatching(/PDFs/))
  })

  it('asks before a plan from a file takes the place of open review suggestions', async () => {
    mocks.attachments = CAP
    await mount({ id: 'r1', kind: 'review', summary: 'two changes', changes: [] })
    await pick([new File([PDF], 'plan.pdf', { type: 'application/pdf' })])
    await click(container.querySelector('.send'))
    expect(refinePlan).not.toHaveBeenCalled()
    expect(confirmSheet).toHaveBeenCalledTimes(1)
    const opts = confirmSheet.mock.calls[0][0]
    expect(opts.title).toMatch(/Replace the open suggestions/)
    await act(async () => { await opts.onConfirm() })
    expect(refinePlan).toHaveBeenCalledTimes(1)
  })

  it('drops picked files, and says so, when the server stops taking them', async () => {
    mocks.attachments = CAP
    await mount(null)
    await pick([new File([PDF], 'plan.pdf', { type: 'application/pdf' })])
    expect(container.querySelector('.attach-chip')).toBeTruthy()
    mocks.attachments = null
    await act(async () => { root.render(React.createElement(CoachChat)) })
    expect(container.querySelector('.attach-chip')).toBeNull()
    expect(container.querySelector('.attach')).toBeNull()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/removed/))
  })
})
