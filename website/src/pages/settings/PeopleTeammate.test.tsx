/** Settings > People as a teammate on a Crew shared over Kiro Login: the
 *  summary names the path that is on, People groups by how each person came
 *  in, the owner keeps their badge, and the owner's usage note stays the
 *  owner's. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../../api/client'
import { ALL_UNAVAILABLE, type PeopleResponse, type PeopleRow } from '../../api/sharedCrewUi'
import type { CrewModeResponse } from '../../api/sharedCrewMode'
import { PeoplePanel } from './PeoplePanel'
import { useViewerIsNotOwner } from '../../hooks/sharedCrew/useSharedCrew'

vi.mock('../../api/client', () => ({
  api: {
    sharedCrewPeople: vi.fn(), sharedCrewCapabilities: vi.fn(), sharedCrewMode: vi.fn(), tailscaleInvites: vi.fn(),
    sharedCrewSsm: vi.fn(), viewerOwnerOk: vi.fn(), kirocrewConfig: vi.fn(), patchConfig: vi.fn(),
  },
}))
vi.mock('../../components/settingRef/useConfigSchema', () => {
  const schema = new Map()
  return { useConfigSchema: () => schema, useConfigSchemaQuery: () => ({ schema, error: null }) }
})
const people = vi.mocked(api.sharedCrewPeople)
const caps = vi.mocked(api.sharedCrewCapabilities)
const modeApi = vi.mocked(api.sharedCrewMode)
const ownerOk = vi.mocked(api.viewerOwnerOk)

// Capabilities, then People and mode, then the owner read: waits spanning it get this ceiling.
const CHAIN_TIMEOUT_MS = 5000

const row = (id: string, name: string, over: Partial<PeopleRow> = {}): PeopleRow => ({
  principal: { id, kind: 'human', display: { name, login: '', captured_at: null } },
  sources: ['observed'], last_seen_at: 1_700_000_000, is_viewer: false, usage: null, ...over,
})

const ROWS: PeopleRow[] = [
  row('p_owner', 'Studio Mac', { is_owner: true, provenance: 'local_operator', sources: ['owner'], last_seen_at: null }),
  row('p_me', 'Siren', { is_viewer: true, provenance: 'kiro_relay' }),
  row('p_bo', 'Bo', { provenance: 'kiro_relay' }),
  row('p_ts', 'Tess', { provenance: 'tailscale_listener' }),
  row('p_slack', 'Sam', { provenance: 'none', sources: ['session_creator'] }),
]

function modeBody(over: Partial<CrewModeResponse> = {}): CrewModeResponse {
  return {
    schema_version: 1, mode: 'network', crew_id: 'crew-a',
    team_config: { state: 'not_configured', reason: '', capability: '', cause: '' },
    console: { state: 'not_offered', url: '' },
    adapters: { tailscale: { state: 'unavailable', reason: '' } },
    workload_identity_ref: 'unavailable',
    viewer_via: 'kiro_login', viewer_is_owner: false, owner_label: 'Studio Mac', sharing_paths: ['kiro_login'], ...over,
  }
}

/** Marks when the owner read answered, in the panel's own query cache. */
function OwnerReadSettled() {
  const { notOwner, owner } = useViewerIsNotOwner()
  return notOwner || owner ? <span data-testid="owner-read" /> : null
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><PeoplePanel /><OwnerReadSettled /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  caps.mockResolvedValue({ ...ALL_UNAVAILABLE, attribution: 'available', shared_crew_preview: true })
  people.mockResolvedValue({ schema_version: 1, directory: { state: 'unavailable' }, usage_available: false, people: ROWS } satisfies PeopleResponse)
  modeApi.mockResolvedValue(modeBody())
  vi.mocked(api.tailscaleInvites).mockResolvedValue(null)
  vi.mocked(api.sharedCrewSsm).mockResolvedValue(null as never)
  ownerOk.mockResolvedValue(false)
})

describe('People for a teammate on a Crew shared over Kiro Login', () => {
  it('names the path that is on instead of "Tailscale: Not set up"', async () => {
    mount()
    const state = await screen.findByTestId('share-hero-state', {}, { timeout: CHAIN_TIMEOUT_MS })
    expect(state).toHaveTextContent('Shared over Kiro Login')
    expect(state).not.toHaveTextContent(/Tailscale|Not set up/)
  })

  it('still shows the Tailscale state when Tailscale is one of the paths on', async () => {
    modeApi.mockResolvedValue(modeBody({ adapters: { tailscale: { state: 'available', reason: '' } }, sharing_paths: ['kiro_login', 'tailscale'] }))
    mount()
    expect(await screen.findByTestId('share-hero-state', {}, { timeout: CHAIN_TIMEOUT_MS })).toHaveTextContent('Tailscale Available')
  })

  it('groups people by how they came in, the owner first with the Crew owner badge', async () => {
    mount()
    const list = await screen.findByTestId('people-list', {}, { timeout: CHAIN_TIMEOUT_MS })
    const owner = within(list).getByTestId('person-p_owner')
    expect(owner).toHaveTextContent('Crew owner')
    // Each group has its own heading and count, in a fixed order.
    const relay = within(list).getByTestId('people-group-kiro_login')
    expect(relay).toHaveTextContent('via Kiro Login2')
    expect(within(relay).getByTestId('person-p_me')).toBeInTheDocument()
    expect(within(relay).getByTestId('person-p_bo')).toBeInTheDocument()
    expect(within(within(list).getByTestId('people-group-tailscale')).getByTestId('person-p_ts')).toBeInTheDocument()
    expect(within(within(list).getByTestId('people-group-unattributed')).getByTestId('person-p_slack')).toBeInTheDocument()
    expect(within(list).queryByTestId('people-group-ssm')).toBeNull()
    const order = Array.from(list.querySelectorAll('[data-testid^="person-p_"]')).map(el => el.getAttribute('data-testid'))
    expect(order).toEqual(['person-p_owner', 'person-p_me', 'person-p_bo', 'person-p_ts', 'person-p_slack'])
    expect(screen.getByText('People · 5')).toBeInTheDocument()
  })

  it('keeps the owner\'s usage note from a teammate, and shows it to the owner', async () => {
    const first = mount()
    await screen.findByTestId('people-list', {}, { timeout: CHAIN_TIMEOUT_MS })
    await screen.findByTestId('owner-read', {}, { timeout: CHAIN_TIMEOUT_MS })
    expect(screen.queryByText(/cannot report how much work/i)).toBeNull()
    first.unmount()
    ownerOk.mockResolvedValue(true)
    mount()
    expect(await screen.findByText(/cannot report how much work/i, {}, { timeout: CHAIN_TIMEOUT_MS })).toBeInTheDocument()
  })
})
