import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock("@radix-ui/react-dropdown-menu", async () => await import("./__mocks__/@radix-ui/react-dropdown-menu"))
vi.mock('../api/client', () => ({
  api: {
    chatMode: vi.fn().mockResolvedValue({}),
    chatSlotApproveForMe: vi.fn().mockResolvedValue({ ok: true, approve_for_me: true }),
  },
}))

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ApiError } from '../api/apiError'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import ApprovalModePicker from '../components/ApprovalModePicker'
import { createTestStore } from './helpers'
import { api } from '../api/client'
import { slotApprovalMode } from '../utils/slotApprovalMode'

function renderPicker(mode: string, approveForMe?: boolean) {
  render(
    <Provider store={createTestStore()}>
      <MemoryRouter>
        <ApprovalModePicker mode={mode} slotKey="dashboard:1" approveForMe={approveForMe} />
      </MemoryRouter>
    </Provider>,
  )
}

describe('ApprovalModePicker: Approve for me', () => {
  beforeEach(() => {
    vi.mocked(api.chatMode).mockClear()
    vi.mocked(api.chatSlotApproveForMe).mockClear()
  })

  it('offers no Approve for me row while the session offers no such option', () => {
    renderPicker('normal')
    fireEvent.click(screen.getByLabelText('Approval mode: Normal'))
    const texts = screen.getAllByRole('menuitem').map(i => i.textContent || '')
    expect(texts).toHaveLength(4)
    expect(texts.some(t => t.includes('Approve for me'))).toBe(false)
  })

  it('says KAS approves shell commands and file edits that skip the safety checks', () => {
    renderPicker('normal', false)
    fireEvent.click(screen.getByLabelText('Approval mode: Normal'))
    const row = screen.getAllByRole('menuitem').map(i => i.textContent || '').find(t => t.includes('Approve for me'))
    expect(row).toBeDefined()
    expect(row).toContain('the Kiro engine this chat runs on')
    expect(row).toContain('decides on its own')
    expect(row).toContain('shell commands and file edits')
    expect(row).toContain('skip')
    expect(row).toContain('still logged')
    expect(row).toContain("asks you when it isn't sure")
  })

  it('picking it writes the session option, not the approval mode', () => {
    renderPicker('normal', false)
    fireEvent.click(screen.getByLabelText('Approval mode: Normal'))
    const row = screen.getAllByRole('menuitem').find(i => (i.textContent || '').includes('Approve for me'))!
    fireEvent.click(row)
    expect(api.chatSlotApproveForMe).toHaveBeenCalledWith('dashboard:1', true)
    expect(api.chatMode).not.toHaveBeenCalled()
  })

  it('says why turning it on failed instead of closing silently', async () => {
    vi.mocked(api.chatSlotApproveForMe).mockRejectedValueOnce(
      new ApiError(409, 'a turn is in flight', JSON.stringify({ code: 'turn_in_flight' })),
    )
    renderPicker('normal', false)
    fireEvent.click(screen.getByLabelText('Approval mode: Normal'))
    fireEvent.click(screen.getAllByRole('menuitem').find(i => (i.textContent || '').includes('Approve for me'))!)
    await waitFor(() => expect(screen.getAllByText('a turn is in flight').length).toBeGreaterThan(0))
  })

  it('reads as the mode only when no Trust, Reads or YOLO holds the slot', () => {
    expect(slotApprovalMode(undefined, undefined, true)).toBe('approve_for_me')
    expect(slotApprovalMode(undefined, { trust: true, trust_scope: '', trust_reads: false }, true)).toBe('trust')
    expect(slotApprovalMode('yolo', undefined, true)).toBe('yolo')
    expect(slotApprovalMode(undefined, undefined, false)).toBe('normal')
  })
})
