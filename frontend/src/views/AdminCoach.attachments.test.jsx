// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The attachment limits on the admin card offer exactly the range the server clamps to, read from
   the `ceilings` it reports, so the card and the config route cannot drift apart again (they did
   once: the inputs stayed at 3.5 MB after the server's ceiling moved to 15 MB). */
const mocks = vi.hoisted(() => ({
  refreshConfig: vi.fn(async () => ({})),
  calls: [],
  bodies: [],
  // The shape GET /api/admin/coach answers with (api/coach/routes.js), trimmed to one provider.
  status: {
    disabledByEnv: false, enabled: true, provider: 'anthropic',
    providers: [{ id: 'anthropic', label: 'Anthropic API', runtime: 'HTTPS', apiKey: true, http: true, connected: false }],
    model: null, models: {}, baseUrl: null, knownModels: null,
    caps: { perProfileDaily: 5, instanceDaily: 0 }, community: false,
    runtime: { ok: false, version: null, error: null, needsKey: true }, authMode: 'shared', boundUid: null,
    auth: { state: 'none' }, unprivileged: { ok: true, dropped: false, why: 'this provider runs no child process' },
    jobsToday: 0, lastSuccess: null, lastError: null, recent: [],
    // What GET /api/admin/coach reports for attachments, ceilings included (api/coach/attachments.js).
    attachments: {
      maxCount: 3, maxBytes: 10485760, maxTotalBytes: 15728640, maxPages: 30, supported: true, maxImageBytes: 7500000,
      ceilings: { maxCount: 5, minBytes: 102400, maxBytes: 15728640, maxTotalBytes: 15728640, maxPages: 100, bodyBytes: 22020096 }
    },
  },
}))
vi.mock('../lib/api.js', () => ({
  api: async (path, opts) => {
    mocks.calls.push([path, opts?.method || 'GET'])
    if (path === '/api/admin/coach') return structuredClone(mocks.status)
    if (path === '/api/admin/coach/config') { mocks.bodies.push(JSON.parse(opts.body)); return { ok: true } }
    return {}
  },
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ refreshConfig: mocks.refreshConfig })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})

const { default: AdminCoach } = await import('./AdminCoach.jsx')

const mounted = []
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(<AdminCoach />))
  await flush()
  return host
}

describe('AdminCoach attachment limits', () => {
  it('bounds each input by the ceilings the server reports, and says them in the hint', async () => {
    const host = await mount()
    const input = label => host.querySelector(`input[aria-label="${label}"]`)
    expect(input('Files per message').getAttribute('max')).toBe('5')
    expect(input('MB per file').getAttribute('max')).toBe('15')
    expect(input('MB per request').getAttribute('max')).toBe('15')
    expect(input('Pages per PDF').getAttribute('max')).toBe('100')
    expect(input('MB per file').getAttribute('min')).toBe('0.1')
    expect(input('MB per file').value).toBe('10')
    expect(input('Pages per PDF').value).toBe('30')
    expect(host.textContent).toContain('At most 15 MB per request and 100 pages per PDF')
    expect(host.textContent).toContain('(21 MB, in nginx and the API)')
    // 7.5 MB of image (Anthropic's 10 MB of base64), in the card's binary megabytes
    expect(host.textContent).toContain('takes images up to 7.2 MB')
    expect(host.textContent).not.toContain('3.5 MB')
  })

  it('saves a changed page limit', async () => {
    const host = await mount()
    const pages = host.querySelector('input[aria-label="Pages per PDF"]')
    act(() => { pages.value = '60'; pages.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await flush()
    expect(mocks.bodies.at(-1)).toEqual({ attachments: { maxPages: 60 } })
  })
})
