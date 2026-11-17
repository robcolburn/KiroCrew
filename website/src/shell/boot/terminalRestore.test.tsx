/**
 * The Terminal is the machine owner's alone (shared-crew.md §2): a tab that
 * `/api/auth/me` says is not the owner never shows it, whatever the probe
 * answered, so no dock opens and no socket dials one the gateway refuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const viewer = vi.hoisted(() => ({ notOwner: false }))
vi.mock('../../hooks/sharedCrew/useSharedCrew', async importOriginal => ({
  ...(await importOriginal<typeof import('../../hooks/sharedCrew/useSharedCrew')>()),
  useViewerIsNotOwner: () => ({ notOwner: viewer.notOwner, owner: !viewer.notOwner, failed: false, error: null, retry: vi.fn() }),
}))

import { useTerminalRestoreProbe } from './terminalRestore'
import { isTerminalEnabled } from '../../utils/terminalRegistry'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  // A probe that fails open (a 403 from an older gateway reads as enabled).
  fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 403 })))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  viewer.notOwner = false
})

describe('useTerminalRestoreProbe', () => {
  it('hides the Terminal from a Shared Crew teammate even when the probe fails open', async () => {
    viewer.notOwner = true
    const { result } = renderHook(() => useTerminalRestoreProbe(), { wrapper })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(result.current).toBe(false)
    expect(isTerminalEnabled()).toBe(false)
  })

  it('keeps the owner\'s Terminal on the same answer', async () => {
    const { result } = renderHook(() => useTerminalRestoreProbe(), { wrapper })
    await waitFor(() => expect(isTerminalEnabled()).toBe(true))
    expect(result.current).toBe(true)
  })
})
