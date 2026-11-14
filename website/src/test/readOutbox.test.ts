import { describe, it, expect, beforeEach } from 'vitest'
import { READ_OUTBOX_KEY, READ_OUTBOX_MAX, ackRead, queueRead, queuedReads, resendKeptReads } from '../lib/readOutbox'

const EARLY = '2026-11-13T10:00:00+00:00'
const LATE = '2026-11-13T11:00:00+00:00'

describe('readOutbox', () => {
  beforeEach(() => { localStorage.clear() })

  it('keeps the newest read per slot, by instant', () => {
    queueRead('a', LATE)
    queueRead('a', EARLY)
    queueRead('b', '2026-11-13T16:00:00+05:00')
    queueRead('b', '2026-11-13T12:00:00+00:00')
    expect(queuedReads()).toEqual({ a: LATE, b: '2026-11-13T12:00:00+00:00' })
  })

  it('ignores a read with no usable time', () => {
    queueRead('a', undefined)
    queueRead('a', 'not a time')
    expect(queuedReads()).toEqual({})
  })

  it('survives a reload: the kept reads live in localStorage', () => {
    queueRead('a', LATE)
    expect(JSON.parse(localStorage.getItem(READ_OUTBOX_KEY) ?? '{}')).toEqual({ a: LATE })
  })

  it('forgets a read only when the stored read covers it', () => {
    queueRead('a', LATE)
    ackRead('a', EARLY)
    ackRead('a', undefined)
    expect(queuedReads()).toEqual({ a: LATE })
    ackRead('a', LATE)
    expect(queuedReads()).toEqual({})
  })

  it('drops the oldest reads past the cap', () => {
    const base = Date.parse(EARLY)
    for (let i = 0; i <= READ_OUTBOX_MAX; i++) queueRead(`s${i}`, new Date(base + i * 1000).toISOString())
    const kept = queuedReads()
    expect(Object.keys(kept)).toHaveLength(READ_OUTBOX_MAX)
    expect(kept.s0).toBeUndefined()
    expect(kept[`s${READ_OUTBOX_MAX}`]).toBeDefined()
  })

  it('resends each kept read once and keeps it until confirmed', () => {
    queueRead('a', EARLY)
    queueRead('b', LATE)
    const sent: Array<[string, string]> = []
    resendKeptReads((slot, ts) => { sent.push([slot, ts]) })
    expect(sent).toEqual([['a', EARLY], ['b', LATE]])
    expect(queuedReads()).toEqual({ a: EARLY, b: LATE })
  })

  it('reads a corrupt record as empty', () => {
    localStorage.setItem(READ_OUTBOX_KEY, '{oops')
    expect(queuedReads()).toEqual({})
    localStorage.setItem(READ_OUTBOX_KEY, JSON.stringify(['a']))
    expect(queuedReads()).toEqual({})
  })
})
