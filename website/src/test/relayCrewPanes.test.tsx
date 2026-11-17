import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { i18nT } from '../i18n/t'
import { renderWithProviders, renderHookWithProviders, createTestStore } from './helpers'
import RelayCrewPaneHost from '../components/RelayCrewPaneHost'
import { RELAY_CREW_PANE_KEY, RELAY_PANE_WARM_CAP, relayPaneBridge, useRelayTabs, type RelayPaneEvent } from '../lib/relayCrewPanes'
import { openRelayCrewTab } from '../hooks/useRelayViewerCrews'
import { NavItem } from '../shell/nav/navRow'
import { localCovered, relayPaneClosed, relayPaneOpened, setActiveId } from '../store/instancesSlice'

const RECT = { x: 236, y: 42, width: 700, height: 500 }

function installBridge(openAnswer: { ok: boolean; error?: string; window?: boolean } = { ok: true }) {
  const listeners: Array<(e: RelayPaneEvent) => void> = []
  const api = {
    open: vi.fn(async () => ({ ok: true })),
    closeAll: vi.fn(async () => undefined),
    openPane: vi.fn(async () => openAnswer),
    setPaneBounds: vi.fn(async () => undefined),
    setPaneOverlay: vi.fn(async () => undefined),
    setPaneInactive: vi.fn(async () => undefined),
    closePane: vi.fn(async () => undefined),
    onPaneEvent: vi.fn((cb: (e: RelayPaneEvent) => void) => {
      listeners.push(cb)
      return () => { listeners.splice(listeners.indexOf(cb), 1) }
    }),
  }
  ;(window as unknown as { relayCrewAPI?: unknown }).relayCrewAPI = api
  const emit = (e: RelayPaneEvent) => act(() => { for (const cb of [...listeners]) cb(e) })
  return { api, emit }
}

function mountMain() {
  const main = document.createElement('main')
  main.id = 'main-content'
  main.getBoundingClientRect = () => RECT as DOMRect
  document.body.appendChild(main)
  return main
}

function storeWith(ids: string[], active: string | null) {
  const store = createTestStore()
  for (const id of ids) store.dispatch(relayPaneOpened({ id, name: id.toUpperCase() }))
  if (active) store.dispatch(relayPaneOpened({ id: active, name: active.toUpperCase() }))
  return store
}

beforeEach(() => {
  class RO { observe() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  localStorage.setItem(RELAY_CREW_PANE_KEY, '1')
})

afterEach(() => {
  delete (window as unknown as { relayCrewAPI?: unknown }).relayCrewAPI
  localStorage.removeItem(RELAY_CREW_PANE_KEY)
  document.getElementById('main-content')?.remove()
  document.querySelectorAll('[data-test-overlay]').forEach(el => el.remove())
  vi.restoreAllMocks()
})

describe('relay Crew panes behind the hidden key', () => {
  it('with the key absent there is no pane bridge, and Open still opens a window', async () => {
    const { api } = installBridge()
    localStorage.removeItem(RELAY_CREW_PANE_KEY)
    expect(relayPaneBridge()).toBeNull()
    localStorage.setItem(RELAY_CREW_PANE_KEY, 'true')
    expect(relayPaneBridge()).toBeNull()
    const store = createTestStore()
    expect(await openRelayCrewTab('r1', 'One', store.dispatch)).toEqual({ ok: true })
    expect(api.open).toHaveBeenCalledWith('r1')
    expect(api.openPane).not.toHaveBeenCalled()
    expect(store.getState().instances.relayTabs).toBeUndefined()
  })

  it('with the key on, Open puts the pane over <main> and makes its tab active; a refusal adds no tab', async () => {
    mountMain()
    const { api } = installBridge()
    const store = createTestStore()
    expect(await openRelayCrewTab('r1', 'One', store.dispatch)).toEqual({ ok: true })
    expect(api.openPane).toHaveBeenCalledWith('r1', RECT, { width: window.innerWidth, height: window.innerHeight })
    expect(api.open).not.toHaveBeenCalled()
    expect(store.getState().instances.relayTabs).toEqual([{ id: 'r1', name: 'One' }])
    expect(store.getState().instances.relayActive).toBe('r1')
    api.openPane.mockResolvedValueOnce({ ok: false, error: 'CREW_OFFLINE' })
    expect(await openRelayCrewTab('r2', 'Two', store.dispatch)).toEqual({ ok: false, error: 'CREW_OFFLINE' })
    expect(store.getState().instances.relayTabs).toEqual([{ id: 'r1', name: 'One' }])
  })

  it('the host shows the active pane at <main>, hides the others, and hides it under a menu outside <main>', async () => {
    const main = mountMain()
    const { api } = installBridge()
    renderWithProviders(<RelayCrewPaneHost />, { store: storeWith(['r1', 'r2'], 'r2') })
    await waitFor(() => expect(api.setPaneInactive).toHaveBeenCalledWith('r2', false))
    expect(api.setPaneInactive).toHaveBeenCalledWith('r1', true)
    expect(api.setPaneBounds).toHaveBeenCalledWith('r2', RECT, { width: window.innerWidth, height: window.innerHeight })
    expect(api.setPaneOverlay).toHaveBeenLastCalledWith('r2', false)
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    main.appendChild(list)
    await new Promise(r => setTimeout(r, 0))
    expect(api.setPaneOverlay).toHaveBeenCalledTimes(1)
    const menu = document.createElement('div')
    menu.setAttribute('data-test-overlay', '')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    await waitFor(() => expect(api.setPaneOverlay).toHaveBeenLastCalledWith('r2', true))
    menu.remove()
    await waitFor(() => expect(api.setPaneOverlay).toHaveBeenLastCalledWith('r2', false))
  })

  it('past the warm cap the least recent hidden pane closes and keeps its tab; any other close drops the tab', async () => {
    mountMain()
    const { api, emit } = installBridge()
    const ids = ['r1', 'r2', 'r3', 'r4'].slice(0, RELAY_PANE_WARM_CAP + 1)
    const store = storeWith(ids, 'r1')
    renderWithProviders(<RelayCrewPaneHost />, { store })
    // Opened in order, then r1 again: r2 is the least recent hidden pane.
    await waitFor(() => expect(api.closePane).toHaveBeenCalledWith('r2'))
    expect(api.closePane).toHaveBeenCalledTimes(1)
    emit({ type: 'closed', endpointId: 'r2', index: -1 })
    expect(store.getState().instances.relayTabs?.map(t => t.id)).toEqual(ids)
    expect(store.getState().instances.relayLive).not.toContain('r2')
    emit({ type: 'closed', endpointId: 'r1', index: -1 })
    expect(store.getState().instances.relayTabs?.map(t => t.id)).not.toContain('r1')
    expect(store.getState().instances.relayActive).toBeNull()
    expect(api.closePane).toHaveBeenCalledTimes(1)
  })
})

describe('useRelayTabs', () => {
  it('reopens an evicted tab through openPane, and a refusal drops it with the refusal kept', async () => {
    mountMain()
    const { api } = installBridge({ ok: false, error: 'CREW_OFFLINE' })
    const store = storeWith(['r1', 'r2'], 'r1')
    const { result } = renderHookWithProviders(() => useRelayTabs(), { store })
    act(() => { store.dispatch(relayPaneClosed({ id: 'r2', keepTab: true })) })
    act(() => result.current.select('r2'))
    await waitFor(() => expect(store.getState().instances.relayRefusal).toBe('CREW_OFFLINE'))
    expect(api.openPane).toHaveBeenCalledWith('r2', RECT, { width: window.innerWidth, height: window.innerHeight })
    expect(store.getState().instances.relayTabs?.map(t => t.id)).toEqual(['r1'])
    renderWithProviders(<RelayCrewPaneHost />, { store })
    expect(screen.getByTestId('relay-crew-pane-refusal')).toBeTruthy()
  })

  it('picks a live tab without a new open, closes a live pane through main and an evicted tab at once', () => {
    const { api } = installBridge()
    const store = storeWith(['r1', 'r2'], 'r1')
    const { result } = renderHookWithProviders(() => useRelayTabs(), { store })
    act(() => result.current.select('r2'))
    expect(store.getState().instances.relayActive).toBe('r2')
    expect(api.openPane).not.toHaveBeenCalled()
    act(() => result.current.close('r1'))
    expect(api.closePane).toHaveBeenCalledWith('r1')
    expect(store.getState().instances.relayTabs?.map(t => t.id)).toEqual(['r1', 'r2'])
    act(() => { store.dispatch(relayPaneClosed({ id: 'r1', keepTab: true })) })
    act(() => result.current.close('r1'))
    expect(store.getState().instances.relayTabs?.map(t => t.id)).toEqual(['r2'])
    expect(api.closePane).toHaveBeenCalledTimes(1)
  })
})

describe('relay pane refusals, windows and the local Crew', () => {
  it('the refusal notice offers the agent, and goes on dismiss or when the local Crew comes forward', () => {
    installBridge()
    const store = storeWith(['r1'], 'r1')
    act(() => { store.dispatch(relayPaneClosed({ id: 'r2', refusal: 'CREW_OFFLINE' })) })
    renderWithProviders(<RelayCrewPaneHost />, { store })
    const notice = screen.getByTestId('relay-crew-pane-refusal')
    expect(within(notice).getByText(i18nT('components.askAgent.ask_the_agent'))).toBeTruthy()
    fireEvent.click(within(notice).getByRole('button', { name: i18nT('components.errorNotice.dismiss') }))
    expect(store.getState().instances.relayRefusal).toBeNull()
    act(() => { store.dispatch(relayPaneClosed({ id: 'r2', refusal: 'CREW_OFFLINE' })) })
    act(() => { store.dispatch(setActiveId(null)) })
    expect(store.getState().instances.relayRefusal).toBeNull()
    expect(screen.queryByTestId('relay-crew-pane-refusal')).toBeNull()
  })

  it('a Crew already open in its own window comes forward there and keeps no tab, from Open or from an evicted tab', async () => {
    mountMain()
    installBridge({ ok: true, window: true })
    const store = storeWith(['r1', 'r2'], 'r1')
    expect(await openRelayCrewTab('r3', 'Three', store.dispatch)).toEqual({ ok: true, window: true })
    expect(store.getState().instances.relayTabs?.map(t => t.id)).toEqual(['r1', 'r2'])
    expect(store.getState().instances.relayActive).toBe('r1')
    const { result } = renderHookWithProviders(() => useRelayTabs(), { store })
    act(() => { store.dispatch(relayPaneClosed({ id: 'r2', keepTab: true })) })
    act(() => result.current.select('r2'))
    await waitFor(() => expect(store.getState().instances.relayTabs?.map(t => t.id)).toEqual(['r1']))
    expect(store.getState().instances.relayActive).toBe('r1')
  })

  it('a nav rail row clicked over a relay tab brings the local Crew forward', () => {
    const store = storeWith(['r1'], 'r1')
    renderWithProviders(<NavItem path="/settings" label="Settings" icon={null} active={false} collapsed={false} />, { store, route: '/chat' })
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    expect(store.getState().instances.relayActive).toBeNull()
  })

  it('localCovered reads an SSH Crew or a relay tab in front, and setActiveId(null) clears both', () => {
    const store = storeWith(['r1'], 'r1')
    expect(localCovered(store.getState())).toBe(true)
    act(() => { store.dispatch(setActiveId(null)) })
    expect(localCovered(store.getState())).toBe(false)
    act(() => { store.dispatch(setActiveId('ssh-1')) })
    expect(localCovered(store.getState())).toBe(true)
  })
})
