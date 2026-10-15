import { describe, it, expect } from 'vitest'
import { checkPicked, toBase64, readAttachment, acceptOf, attachmentErrorText } from './coach-attachments.js'

const CAP = { types: ['application/pdf', 'image/jpeg', 'image/png'], maxCount: 2, maxBytes: 1000, maxTotalBytes: 1500 }
const f = (name, type, size) => ({ name, type, size })

describe('checkPicked', () => {
  it('takes files of the listed types within every limit', () => {
    expect(checkPicked([], [f('a.pdf', 'application/pdf', 900), f('b.png', 'image/png', 500)], CAP)).toEqual({ ok: true })
  })
  it('names the limit that was crossed, with the reasons the server uses', () => {
    expect(checkPicked([], [f('a.pdf', 'application/pdf', 1)], null).reason).toBe('unsupported')
    expect(checkPicked([], [f('a.gif', 'image/gif', 10)], CAP).reason).toBe('type')
    expect(checkPicked([], [f('a.pdf', 'application/pdf', 1001)], CAP).reason).toBe('size')
    expect(checkPicked([], [f('a.pdf', 'application/pdf', 0)], CAP).reason).toBe('malformed')
    expect(checkPicked([f('a.pdf', 'application/pdf', 900)], [f('b.pdf', 'application/pdf', 900)], CAP).reason).toBe('total')
    expect(checkPicked([f('a.pdf', 'application/pdf', 1), f('b.pdf', 'application/pdf', 1)], [f('c.pdf', 'application/pdf', 1)], CAP).reason).toBe('count')
  })
  it('counts files already picked, which carry mediaType rather than type', () => {
    expect(checkPicked([{ name: 'a.pdf', mediaType: 'application/pdf', size: 1400 }], [f('b.png', 'image/png', 200)], CAP).reason).toBe('total')
  })
})

describe('reading a file', () => {
  it('encodes bytes as plain base64, also past one chunk', () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 251)
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
  it('turns a picked File into { name, mediaType, size, data }', async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'plan.pdf', { type: 'application/pdf' })
    expect(await readAttachment(file)).toEqual({ name: 'plan.pdf', mediaType: 'application/pdf', size: 5, data: 'JVBERi0=' })
  })
  it('offers the picker only the types the server listed', () => {
    expect(acceptOf(CAP)).toBe('application/pdf,image/jpeg,image/png')
    expect(acceptOf(null)).toBe('')
  })
})

describe('attachmentErrorText', () => {
  it('adds the limit to the line where there is one', () => {
    expect(attachmentErrorText('count', CAP)).toMatch(/2/)
    expect(attachmentErrorText('nonsense', CAP)).toBe(attachmentErrorText('malformed', CAP))
  })
})
