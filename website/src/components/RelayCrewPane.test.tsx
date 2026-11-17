/**
 * A Team Crew as a pane in the desktop app's main window: Connect opens it at
 * the region's rect, a resize moves it, a local dialog hides it, another tab in
 * front makes it inactive, the shell's `closed` drops its chip, its forwarded
 * chord switches tabs, and a reload closes what the last load left open.
 * The shell is a stub `window.relayCrewAPI`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation, useNavigate } from 'react-router-dom'
import RelayCrewPane from './RelayCrewPane'
import RelayCrewChips from './RelayCrewChip'
import { resetRelayPaneLoadForTest, useConnectRelayCrew } from '../hooks/useRelayCrewPane'
import type { RelayPaneEvent } from '../lib/relayCrewPaneBridge'
import { setActiveId } from '../store/instancesSlice'
import { SHORTCUTS_ENABLED_KEY } from '../hooks/useKeyboardShortcuts'
import { createTestStore, renderWithProviders } from '../test/helpers'

let rect = { x: 0, y: 42, width: 800, height: 558 }
const resizeCallbacks: Array<() => void> = []

function stubBridge() {
  let listener: ((e: RelayPaneEvent) => void) | null = null
  const bridge = {
    open: vi.fn(async (_id: string) => ({ ok: true })),
    openPane: vi.fn(async (_id: string, _r: unknown, _v: unknown) => ({ ok: true })),
    setPaneBounds: vi.fn(async (_id: string, _r: unknown, _v: unknown) => undefined),
    setPaneOverlay: vi.fn(async (_id: string, _a: boolean) => undefined),
    setPaneInactive: vi.fn(async (_id: string, _i: boolean) => undefined),
    closePane: vi.fn(async (_id: string) => undefined),
    onPaneEvent: vi.fn((cb: (e: RelayPaneEvent) => void) => {
      listener = cb
      return () => { listener = null }
    }),
  }
  ;(window as { relayCrewAPI?: unknown }).relayCrewAPI = bridge
  const emit = (e: RelayPaneEvent) => act(() => { listener?.(e) })
  return { bridge, emit }
}

function Harness() {
  const connect = useConnectRelayCrew()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (
    <>
      <RelayCrewPane />
      <RelayCrewChips />
      <button type="button" onClick={() => void connect({ endpointId: 'ep-1', name: 'Lab' })}>connect</button>
      <button type="button" onClick={() => void connect({ endpointId: 'ep-2', name: 'Lab Two' })}>connect two</button>
      <button type="button" onClick={() => navigate('/settings')}>navigate</button>
      <button type="button" onClick={() => navigate(pathname)}>reselect</button>
      <button type="button" onClick={() => navigate('/chat/titled', { replace: true })}>rewrite</button>
      <input aria-label="local composer" />
    </>
  )
}

function mount() {
  const store = createTestStore({ instances: { warm: {}, activeId: null, mru: [], unread: {} } as never })
  renderWithProviders(<Harness />, { store })
  return store
}

async function connected() {
  const stub = stubBridge()
  const store = mount()
  const u = userEvent.setup()
  await u.click(screen.getByRole('button', { name: 'connect' }))
  await screen.findByTestId('relay-crew-chip')
  return { ...stub, store, u }
}

const lastCall = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[fn.mock.calls.length - 1]

beforeEach(() => {
  rect = { x: 0, y: 42, width: 800, height: 558 }
  resizeCallbacks.length = 0
  resetRelayPaneLoadForTest()
  sessionStorage.clear()
  localStorage.clear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect }) as DOMRect)
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resizeCallbacks.push(cb) }
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (window as { relayCrewAPI?: unknown }).relayCrewAPI
})

describe('RelayCrewPane', () => {
  it('renders no region without the pane bridge', () => {
    mount()
    expect(screen.queryByTestId('relay-crew-pane-region')).toBeNull()
  })

  it('an older shell without openPane opens the Crew in its own window', async () => {
    const open = vi.fn(async (_id: string) => ({ ok: true }))
    ;(window as { relayCrewAPI?: unknown }).relayCrewAPI = { open }
    mount()
    expect(screen.queryByTestId('relay-crew-pane-region')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'connect' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('ep-1'))
    expect(screen.queryByTestId('relay-crew-chip')).toBeNull()
  })

  it('an SSH Crew\'s embedded pane never opens a Team Crew pane', async () => {
    const { bridge } = stubBridge()
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window)
    mount()
    expect(screen.queryByTestId('relay-crew-pane-region')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'connect' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith('ep-1'))
    expect(bridge.openPane).not.toHaveBeenCalled()
  })

  it('opens the pane at the region rect with the viewport, then shows it with a chip', async () => {
    const { bridge, store } = await connected()
    expect(bridge.openPane).toHaveBeenCalledTimes(1)
    expect(bridge.openPane.mock.calls[0]).toEqual([
      'ep-1', { x: 0, y: 42, width: 800, height: 558 }, { width: window.innerWidth, height: window.innerHeight },
    ])
    expect(bridge.open).not.toHaveBeenCalled()
    expect(store.getState().instances.relayActive).toBe('ep-1')
    expect(screen.getByTestId('relay-crew-pane-region').getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('button', { name: 'Lab (Team Crew)' }).getAttribute('aria-current')).toBe('true')
    await waitFor(() => expect(bridge.setPaneInactive).toHaveBeenCalledWith('ep-1', false))
  })

  it('moves the pane when the region resizes', async () => {
    const { bridge } = await connected()
    rect = { x: 0, y: 8, width: 1000, height: 700 }
    act(() => { for (const cb of resizeCallbacks) cb() })
    expect(lastCall(bridge.setPaneBounds)).toEqual([
      'ep-1', { x: 0, y: 8, width: 1000, height: 700 }, { width: window.innerWidth, height: window.innerHeight },
    ])
  })

  it('hides the pane while a local dialog is open over it', async () => {
    const { bridge } = await connected()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    await waitFor(() => expect(lastCall(bridge.setPaneOverlay)).toEqual(['ep-1', true]))
    dialog.remove()
    await waitFor(() => expect(lastCall(bridge.setPaneOverlay)).toEqual(['ep-1', false]))
  })

  it('hands the keyboard back to the pane in front when a local overlay closes', async () => {
    const { bridge } = await connected()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    await waitFor(() => expect(lastCall(bridge.setPaneOverlay)).toEqual(['ep-1', true]))
    // The overlay returned focus to a Local element on close.
    const input = screen.getByRole('textbox', { name: 'local composer' })
    input.focus()
    const opens = bridge.openPane.mock.calls.length
    dialog.remove()
    await waitFor(() => expect(bridge.openPane.mock.calls.length).toBe(opens + 1))
    expect(lastCall(bridge.openPane)?.[0]).toBe('ep-1')
    expect(document.activeElement).not.toBe(input)
  })

  it('hands the keyboard to the pane again when its chip is clicked while it is in front', async () => {
    const { bridge, u } = await connected()
    const opens = bridge.openPane.mock.calls.length
    await u.click(screen.getByRole('button', { name: 'Lab (Team Crew)' }))
    await waitFor(() => expect(bridge.openPane.mock.calls.length).toBe(opens + 1))
    expect(lastCall(bridge.openPane)?.[0]).toBe('ep-1')
  })

  it('Connect on the pane already in front leaves no skip behind: its chip still focuses it', async () => {
    const { bridge, u } = await connected()
    await u.click(screen.getByRole('button', { name: 'connect' }))
    await waitFor(() => expect(bridge.openPane).toHaveBeenCalledTimes(2))
    await u.click(screen.getByRole('button', { name: 'Lab (Team Crew)' }))
    await waitFor(() => expect(bridge.openPane).toHaveBeenCalledTimes(3))
    expect(lastCall(bridge.openPane)?.[0]).toBe('ep-1')
  })

  it('makes the pane inactive when Local comes forward, and active again from its chip', async () => {
    const { bridge, store, u } = await connected()
    act(() => { store.dispatch(setActiveId(null)) })
    await waitFor(() => expect(lastCall(bridge.setPaneInactive)).toEqual(['ep-1', true]))
    expect(screen.getByTestId('relay-crew-pane-region').getAttribute('data-active')).toBe('false')
    await u.click(screen.getByRole('button', { name: 'Lab (Team Crew)' }))
    await waitFor(() => expect(lastCall(bridge.setPaneInactive)).toEqual(['ep-1', false]))
    expect(store.getState().instances.relayActive).toBe('ep-1')
  })

  it('a local navigation brings Local forward', async () => {
    const { bridge, store, u } = await connected()
    await u.click(screen.getByRole('button', { name: 'navigate' }))
    await waitFor(() => expect(store.getState().instances.relayActive).toBeNull())
    await waitFor(() => expect(lastCall(bridge.setPaneInactive)).toEqual(['ep-1', true]))
  })

  it('a navigation to the path already shown brings Local forward too', async () => {
    // Selecting the Local chat whose URL is current pushes a new history entry at
    // the same path; the user asked for Local, so the pane steps back.
    const { store, u } = await connected()
    await u.click(screen.getByRole('button', { name: 'reselect' }))
    await waitFor(() => expect(store.getState().instances.relayActive).toBeNull())
  })

  it('keeps the pane in front when the page only rewrites its own URL', async () => {
    const { store, u } = await connected()
    await u.click(screen.getByRole('button', { name: 'rewrite' }))
    expect(store.getState().instances.relayActive).toBe('ep-1')
  })

  it('moves the keyboard off Local into the pane brought forward', async () => {
    const { bridge, store, u } = await connected()
    act(() => { store.dispatch(setActiveId(null)) })
    const input = screen.getByRole('textbox', { name: 'local composer' })
    input.focus()
    const opens = bridge.openPane.mock.calls.length
    await u.keyboard('{Control>}')
    act(() => { store.dispatch({ type: 'instances/showRelayPane', payload: 'ep-1' }) })
    await waitFor(() => expect(bridge.openPane.mock.calls.length).toBeGreaterThan(opens))
    expect(lastCall(bridge.openPane)?.[0]).toBe('ep-1')
    expect(document.activeElement).not.toBe(input)
  })

  it('puts a pane back behind Local when its late focus lands after the switch away', async () => {
    const { bridge, store } = await connected()
    act(() => { store.dispatch(setActiveId(null)) })
    let finish: (v: { ok: boolean }) => void = () => undefined
    bridge.openPane.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => { store.dispatch({ type: 'instances/showRelayPane', payload: 'ep-1' }) })
    await waitFor(() => expect(bridge.openPane).toHaveBeenCalledTimes(2))
    act(() => { store.dispatch(setActiveId(null)) })
    await waitFor(() => expect(lastCall(bridge.setPaneInactive)).toEqual(['ep-1', true]))
    const before = bridge.setPaneInactive.mock.calls.length
    await act(async () => { finish({ ok: true }) })
    await waitFor(() => expect(bridge.setPaneInactive.mock.calls.length).toBeGreaterThan(before))
    expect(lastCall(bridge.setPaneInactive)).toEqual(['ep-1', true])
  })

  it('hands the keyboard to the pane now in front when another pane\'s late focus lands', async () => {
    const { bridge, store, u } = await connected()
    await u.click(screen.getByRole('button', { name: 'connect two' }))
    await screen.findByRole('button', { name: 'Lab Two (Team Crew)' })
    let finish: (v: { ok: boolean }) => void = () => undefined
    bridge.openPane.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => { store.dispatch({ type: 'instances/showRelayPane', payload: 'ep-1' }) })
    const calls = bridge.openPane.mock.calls.length
    act(() => { store.dispatch({ type: 'instances/showRelayPane', payload: 'ep-2' }) })
    await waitFor(() => expect(bridge.openPane.mock.calls.length).toBeGreaterThan(calls))
    const before = bridge.openPane.mock.calls.length
    await act(async () => { finish({ ok: true }) })
    await waitFor(() => expect(bridge.openPane.mock.calls.length).toBeGreaterThan(before))
    expect(lastCall(bridge.openPane)?.[0]).toBe('ep-2')
    expect(bridge.setPaneInactive.mock.calls.some(c => c[0] === 'ep-1' && c[1] === true)).toBe(true)
  })

  it("drops the chip and returns to Local on the shell's closed event", async () => {
    const { emit, store } = await connected()
    emit({ type: 'closed', endpointId: 'ep-1', index: -1 })
    expect(screen.queryByTestId('relay-crew-chip')).toBeNull()
    expect(store.getState().instances.relayActive).toBeNull()
    expect(store.getState().instances.relayPanes).toEqual([])
  })

  it('closes the pane from its chip', async () => {
    const { bridge, store, u } = await connected()
    await u.click(screen.getByRole('button', { name: 'Close Lab' }))
    expect(bridge.closePane).toHaveBeenCalledWith('ep-1')
    expect(screen.queryByTestId('relay-crew-chip')).toBeNull()
    expect(store.getState().instances.relayActive).toBeNull()
  })

  it('switches tabs on a chord the pane forwards, numbering the pane after the instance tabs', async () => {
    const { emit, store } = await connected()
    emit({ type: 'chord', endpointId: 'ep-1', index: 0 })
    expect(store.getState().instances.relayActive).toBeNull()
    // No instance tabs here, so the Team Crew pane is tab 2.
    emit({ type: 'chord', endpointId: 'ep-1', index: 1 })
    expect(store.getState().instances.relayActive).toBe('ep-1')
    // A digit with no tab does nothing.
    emit({ type: 'chord', endpointId: 'ep-1', index: 5 })
    expect(store.getState().instances.relayActive).toBe('ep-1')
  })

  it('ignores a forwarded chord while keyboard shortcuts are off', async () => {
    const { emit, store } = await connected()
    localStorage.setItem(SHORTCUTS_ENABLED_KEY, '0')
    emit({ type: 'chord', endpointId: 'ep-1', index: 0 })
    expect(store.getState().instances.relayActive).toBe('ep-1')
  })

  it('a refused open adds no chip', async () => {
    const { bridge } = stubBridge()
    bridge.openPane.mockResolvedValue({ ok: false, error: 'CREW_OFFLINE' } as never)
    const store = mount()
    await userEvent.setup().click(screen.getByRole('button', { name: 'connect' }))
    await waitFor(() => expect(bridge.openPane).toHaveBeenCalled())
    expect(screen.queryByTestId('relay-crew-chip')).toBeNull()
    expect(store.getState().instances.relayActive ?? null).toBeNull()
  })

  it('closes, once per load, the panes the last load left open', async () => {
    sessionStorage.setItem('mc-relay-panes-opened', JSON.stringify(['ep-old']))
    const { bridge } = stubBridge()
    mount()
    await waitFor(() => expect(bridge.closePane).toHaveBeenCalledWith('ep-old'))
    expect(sessionStorage.getItem('mc-relay-panes-opened')).toBeNull()
    expect(bridge.openPane).not.toHaveBeenCalled()
  })

  it('records the open panes so the next load can close them', async () => {
    await connected()
    await waitFor(() => expect(sessionStorage.getItem('mc-relay-panes-opened')).toBe(JSON.stringify(['ep-1'])))
  })
})
