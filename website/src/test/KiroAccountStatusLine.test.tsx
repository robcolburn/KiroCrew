import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import { KiroAccountStatusLine } from '../pages/developer/KiroAccountStatusLine'
import { KIRO_SIGN_IN_PATH } from '../pages/developer/kiroSignInLink'
import { api, type KasLoginStatus } from '../api/client'

vi.mock('../api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../api/client')>()
  return { ...mod, api: { ...mod.api, kasLoginStatus: vi.fn() } }
})

const kasLoginStatus = vi.mocked(api.kasLoginStatus)
const SIGNED_IN: KasLoginStatus = {
  authenticated: true, provider: 'Google', identity: 'social', transport: 'device',
  expires_at: '2099-01-01T00:00:00Z', expired: false, has_refresh_token: true, refresh_rejected: false, usable: true,
}

afterEach(() => {
  cleanup()
  kasLoginStatus.mockReset()
})

describe('KiroAccountStatusLine', () => {
  it('says Not signed in, with the way to the Kiro account tab', async () => {
    kasLoginStatus.mockResolvedValue({ ...SIGNED_IN, authenticated: false, provider: '', identity: '' })
    renderWithProviders(<KiroAccountStatusLine />)
    await waitFor(() => expect(screen.getByTestId('kiro-account-status')).toHaveTextContent('Not signed in'))
    expect(screen.getByRole('link', { name: 'Go to Kiro account' })).toHaveAttribute('href', KIRO_SIGN_IN_PATH)
  })

  it('names the account when the KAS harness reading names it', async () => {
    kasLoginStatus.mockResolvedValue(SIGNED_IN)
    const { queryClient } = renderWithProviders(<KiroAccountStatusLine />)
    queryClient.setQueryData(['kirocrewConfig'], { agent: { acp_backend: 'kas' } })
    queryClient.setQueryData(['kiro-usage'], { account: 'Ada Lovelace', used: 1, limit: 2 })
    await waitFor(() => expect(screen.getByTestId('kiro-account-status')).toHaveTextContent('Signed in as Ada Lovelace'))
  })

  it('names only the provider off KAS, never the kiro-cli account the reading names there', async () => {
    kasLoginStatus.mockResolvedValue(SIGNED_IN)
    const { queryClient } = renderWithProviders(<KiroAccountStatusLine />)
    queryClient.setQueryData(['kirocrewConfig'], { agent: { acp_backend: 'kiro' } })
    queryClient.setQueryData(['kiro-usage'], { account: 'Someone Else', used: 1, limit: 2 })
    await waitFor(() => expect(screen.getByTestId('kiro-account-status')).toHaveTextContent('Signed in with Google'))
    expect(screen.queryByText(/Someone Else/)).toBeNull()
  })
})
