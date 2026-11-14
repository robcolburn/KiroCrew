/** Reads the gateway has not confirmed yet (`mc-read-outbox`: slot -> newest time), kept across a reload.
 * Each counts as read until a `stored` echo or a row's `last_read_ts` covers it, and each new socket resends it. */
import { safeGetItem, safeSetItem } from '../utils/safeStorage'
import { newerTs } from './slotReadRelay'
import { readCovers } from '../store/dashboard/unread'

export const READ_OUTBOX_KEY = 'mc-read-outbox'

/** Far above any real number of unconfirmed reads; past it the oldest go. */
export const READ_OUTBOX_MAX = 500

const load = (): Record<string, string> => {
  try {
    const raw = JSON.parse(safeGetItem(READ_OUTBOX_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v
    }
    return out
  } catch { return {} }
}

const store = (entries: Record<string, string>): void => {
  let kept = Object.entries(entries)
  if (kept.length > READ_OUTBOX_MAX) {
    kept = kept.sort(([, a], [, b]) => Date.parse(a) - Date.parse(b)).slice(-READ_OUTBOX_MAX)
  }
  safeSetItem(READ_OUTBOX_KEY, JSON.stringify(Object.fromEntries(kept)))
}

export function queueRead(slot: string, readTs: string | undefined): void {
  if (!slot || !readTs || !Number.isFinite(Date.parse(readTs))) return
  const entries = load()
  const next = newerTs(entries[slot], readTs)
  if (next === entries[slot]) return
  entries[slot] = next as string
  store(entries)
}

export function ackRead(slot: string, storedTs: string | undefined): void {
  const entries = load()
  const queued = entries[slot]
  if (queued === undefined || !readCovers(storedTs, queued)) return
  delete entries[slot]
  store(entries)
}

export function queuedReads(): Record<string, string> {
  return load()
}

/** Send every kept read once through *send*; a new socket calls this as it opens. */
export function resendKeptReads(send: (slot: string, readTs: string) => void): void {
  for (const [slot, readTs] of Object.entries(load())) send(slot, readTs)
}
