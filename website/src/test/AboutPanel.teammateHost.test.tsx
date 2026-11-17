// Settings > About's tagline on a Crew viewed by a teammate: the Crew does not
// run on the teammate's own machine, so "runs locally" names the host instead.
// The owner's own view keeps "runs locally".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../store'
import { sseStatus } from '../store/dashboardSlice'
import { AboutPanel } from '../pages/settings/AboutPanel'

// The teammate tagline sits behind two chained reads: `/api/auth/me` answers
// owner_ok first, and only a non-owner then enables the mode query whose
// owner_label names the host. Waits that span that chain get this ceiling.
const CHAIN_TIMEOUT_MS = 5000

const BLANK_STATUS = { uptime: '1m', sessions: 0, messages: 0, cron_jobs: 0, subagents: 0, lessons: 0, version: '0.12.1' } as const

/** Answers `/api/auth/me` with `ownerOk` and the mode route with `ownerLabel`. */
function stubFetch(ownerOk: boolean, ownerLabel?: string) {
  const json = (body: unknown) => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  })
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/auth/me')) return json({ owner_ok: ownerOk })
    if (url.includes('/api/shared-crew/mode')) return json(ownerLabel ? { owner_label: ownerLabel } : {})
    if (url.includes('/api/releases')) return json({ current_version: '0.12.1', stale: false, releases: [] })
    return json({})
  }))
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <Provider store={store}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AboutPanel />
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  )
}

describe('AboutPanel tagline names the Crew host for a teammate', () => {
  beforeEach(() => {
    act(() => { store.dispatch(sseStatus({ ...BLANK_STATUS } as never)) })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('says the Crew runs on the host machine', async () => {
    stubFetch(false, 'build-box')
    mount()
    // Chain: auth/me (owner_ok false) -> mode (owner_label).
    expect(await screen.findByText('Autonomous agent management · runs on build-box · open source', {}, { timeout: CHAIN_TIMEOUT_MS })).toBeInTheDocument()
    expect(screen.queryByText(/runs locally/)).not.toBeInTheDocument()
  })

  it("keeps the owner's own tagline", async () => {
    stubFetch(true, 'build-box')
    mount()
    expect(await screen.findByText('Autonomous agent management · runs locally · open source')).toBeInTheDocument()
  })
})
