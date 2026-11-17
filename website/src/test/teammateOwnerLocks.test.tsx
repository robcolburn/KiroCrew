/**
 * The owner-only locks a Shared Crew teammate sees (shared-crew.md §7): each
 * surface that stays the machine owner's shows one calm line naming the owner,
 * with no error notice, no retry, no agent hand-off and no CLI step, and its
 * owner-only reads are never issued.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './helpers'

const viewer = vi.hoisted(() => ({ notOwner: true, ownerLabel: 'linux-e2e' as string | undefined }))
vi.mock('../hooks/sharedCrew/useSharedCrew', async importOriginal => ({
  ...(await importOriginal<typeof import('../hooks/sharedCrew/useSharedCrew')>()),
  useViewerIsTeammate: () => viewer.notOwner,
  useSharedCrewMode: (enabled = true) => ({ data: enabled && viewer.ownerLabel !== undefined ? { owner_label: viewer.ownerLabel } : undefined }),
}))

import { SecretsPanelLegacy } from '../pages/settings/SecretsPanelLegacy'
import { SecretsPanel } from '../pages/settings/SecretsPanel'
import { RemoteCrewPanel } from '../pages/settings/RemoteCrewPanel'
import { MobileLoginCard } from '../pages/settings/MobileLoginCard'
import { TailnetOriginCard } from '../pages/settings/SecurityPanelTailnet'
import { WebhooksPanel } from '../pages/settings/WebhooksPanel'
import { OwnerOnlyNotice, OwnerOnlyOrError } from '../components/OwnerOnlyNotice'
import { ApiError } from '../api/apiError'

let fetchMock: ReturnType<typeof vi.fn>
const requested = (prefix: string) => fetchMock.mock.calls.some(([url]) => String(url).startsWith(prefix))

beforeEach(() => {
  viewer.notOwner = true
  viewer.ownerLabel = 'linux-e2e'
  fetchMock = vi.fn((url: unknown) => String(url).startsWith('/api/tailnet/status')
    ? Promise.resolve(new Response(JSON.stringify({ state: 'off', enabled: false, resolved_at: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

/** No failure surface and no way out that cannot work for a teammate. */
function expectCalmLock() {
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(/Ask the agent/i)).toBeNull()
  expect(screen.queryByText(/Try again/i)).toBeNull()
  expect(screen.queryByText(/kirocrew /)).toBeNull()
}

describe('teammate owner-only locks', () => {
  it('Secrets (single page) names the owner instead of the vault, Add secret and the CLI step', () => {
    renderWithProviders(<SecretsPanelLegacy />)
    expect(screen.getByTestId('owner-only-secrets')).toHaveTextContent('Secrets are managed by the person at linux-e2e.')
    expect(screen.queryByText('Add secret')).toBeNull()
    expectCalmLock()
    expect(requested('/api/secrets')).toBe(false)
  })

  it('Secrets (vault) reads in its generic form when the mode route names no owner', () => {
    viewer.ownerLabel = undefined
    renderWithProviders(<SecretsPanel />)
    expect(screen.getByTestId('owner-only-secrets')).toHaveTextContent("Secrets are managed by the Crew's owner.")
    expect(screen.queryByText('Add secret')).toBeNull()
    expectCalmLock()
    expect(requested('/api/secrets')).toBe(false)
  })

  it('Remote Crew shows the lock, not the "management is off" card with its Enable button', () => {
    renderWithProviders(<RemoteCrewPanel />)
    expect(screen.getByTestId('owner-only-remote')).toHaveTextContent('Only the person at linux-e2e can manage remote Crews from this Crew.')
    expect(screen.queryByRole('button', { name: /Enable remote crew management/i })).toBeNull()
    expectCalmLock()
    expect(requested('/api/instances')).toBe(false)
  })

  it('the owner keeps the panel itself', async () => {
    viewer.notOwner = false
    renderWithProviders(<SecretsPanelLegacy />)
    await waitFor(() => expect(requested('/api/secrets')).toBe(true))
    expect(screen.queryByTestId('owner-only-secrets')).toBeNull()
  })
})

describe('OwnerOnlyOrError', () => {
  const refusal = (code: string) => new ApiError(403, 'no', JSON.stringify({ error: 'no', code }))
  const failure = <span data-testid="the-error">failed</span>

  it.each(['owner_only', 'relay_local_credential', 'relay_shutdown_refused'])('renders a %s refusal as the lock, not the error', code => {
    renderWithProviders(<OwnerOnlyOrError error={refusal(code)} kind="secrets">{failure}</OwnerOnlyOrError>)
    expect(screen.getByTestId('owner-only-secrets')).toHaveTextContent('Secrets are managed by the person at linux-e2e.')
    expect(screen.queryByTestId('the-error')).toBeNull()
  })

  it('offers the call site\'s agent hand-off on the lock, and none where the site keeps it off', () => {
    const { unmount } = renderWithProviders(<OwnerOnlyOrError error={refusal('owner_only')} kind="secrets" askAgent>{failure}</OwnerOnlyOrError>)
    expect(screen.getByTestId('owner-only-secrets')).toHaveTextContent('Secrets are managed by the person at linux-e2e.')
    expect(screen.getByText('Ask the agent')).toBeInTheDocument()
    unmount()
    // A site next to an unsaved draft passes no askAgent, so the lock loses nothing either.
    renderWithProviders(<OwnerOnlyOrError error={refusal('owner_only')} kind="secrets">{failure}</OwnerOnlyOrError>)
    expect(screen.getByTestId('owner-only-secrets')).toBeInTheDocument()
    expect(screen.queryByText('Ask the agent')).toBeNull()
  })

  it('keeps any other failure as the surface\'s own error', () => {
    renderWithProviders(<OwnerOnlyOrError error={new ApiError(500, 'boom', '{}')} kind="secrets">{failure}</OwnerOnlyOrError>)
    expect(screen.getByTestId('the-error')).toBeInTheDocument()
    expect(screen.queryByTestId('owner-only-secrets')).toBeNull()
  })

  it('reads generically outside a QueryClientProvider', () => {
    render(<OwnerOnlyNotice kind="generic" />)
    expect(screen.getByTestId('owner-only-generic')).toHaveTextContent("Only the Crew's owner can change this.")
  })
})

describe('MobileLoginCard', () => {
  it('shows a teammate the sign-in link lock and no Create button', () => {
    renderWithProviders(<MobileLoginCard />)
    expect(screen.getByTestId('owner-only-sign_in_link')).toHaveTextContent('Only the person at linux-e2e can create sign-in links for this Crew.')
    expect(screen.queryByRole('button')).toBeNull()
    expectCalmLock()
  })
})

describe('admission and credential mints', () => {
  it('Tailnet origin: the admission switch is disabled and says who changes it', async () => {
    renderWithProviders(<TailnetOriginCard />)
    expect(await screen.findByTestId('owner-only-admission')).toHaveTextContent('Only the person at linux-e2e can change who can reach this Crew.')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true')
  })

  it('Webhooks summary names who mints and revokes tokens', () => {
    renderWithProviders(<WebhooksPanel />)
    expect(screen.getByTestId('owner-only-webhooks')).toHaveTextContent('Only the person at linux-e2e can create or revoke webhook tokens.')
  })
})
