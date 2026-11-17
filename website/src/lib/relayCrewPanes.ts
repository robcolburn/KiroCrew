/**
 * Relay Crews as tabs in this window: the desktop shell shows the Crew as a
 * native pane over <main>, under the local top bar, instead of in a window of
 * its own. Only the endpoint ID, the pane's rect and on/off flags cross the
 * bridge; the Crew's own page has no preload and sends nothing.
 *
 * shortcut: off unless the hidden key below reads "1", with no setting to turn
 * it on, until the pane replaces the window and the key goes.
 */
import { useCallback } from 'react'
import { useAppDispatch, useAppSelector, type AppDispatch } from '../store'
import { relayPaneClosed, relayPaneOpened, type RelayTab } from '../store/instancesSlice'
import { safeGetItem } from '../utils/safeStorage'
import { OVERLAY_SELECTOR } from '../hooks/useNativeBrowser'

export const RELAY_CREW_PANE_KEY = 'mc-relay-crew-pane'
/** shortcut: a placeholder for how many relay panes stay loaded; the least recent hidden one closes past it. */
export const RELAY_PANE_WARM_CAP = 3
/** The Preview panel's overlays, plus menus and lists: the switcher's own menu drops over the pane. */
export const RELAY_PANE_OVERLAY_SELECTOR = [OVERLAY_SELECTOR, '[role="menu"],[role="listbox"]'].join(',')

type Rect = { x: number; y: number; width: number; height: number }
type Viewport = { width: number; height: number }
/** `window`: the Crew is open in a window of its own, which came forward instead; no pane exists. */
type OpenResult = { ok: boolean; error?: string; window?: boolean }
export type RelayPaneEvent = { type: string; endpointId: string; index: number }
export type RelayPaneBridge = {
  openPane: (endpointId: string, rect: Rect, viewport: Viewport) => Promise<OpenResult>
  setPaneBounds: (endpointId: string, rect: Rect, viewport: Viewport) => Promise<unknown>
  setPaneOverlay: (endpointId: string, active: boolean) => Promise<unknown>
  setPaneInactive: (endpointId: string, inactive: boolean) => Promise<unknown>
  closePane: (endpointId: string) => Promise<unknown>
  onPaneEvent: (cb: (event: RelayPaneEvent) => void) => () => void
}

/** The pane half of the desktop bridge, or null while the hidden key is off or the shell has none. */
export function relayPaneBridge(): RelayPaneBridge | null {
  if (safeGetItem(RELAY_CREW_PANE_KEY) !== '1') return null
  const b = (window as { relayCrewAPI?: Partial<RelayPaneBridge> }).relayCrewAPI
  return typeof b?.openPane === 'function' && typeof b.onPaneEvent === 'function' ? (b as RelayPaneBridge) : null
}

/** Where the pane goes: <main>'s rect in CSS px, with this page's viewport. */
export function relayPaneRect(): [Rect, Viewport] | null {
  const r = document.getElementById('main-content')?.getBoundingClientRect()
  if (!r) return null
  return [{ x: r.x, y: r.y, width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }]
}

/** Open (or bring forward) a relay Crew's pane and make its tab the active one. Never throws. */
export async function openRelayPane(bridge: RelayPaneBridge, tab: RelayTab, dispatch: AppDispatch): Promise<OpenResult> {
  const at = relayPaneRect()
  let res: OpenResult = { ok: false, error: 'UNAVAILABLE' }
  try {
    if (at) res = await bridge.openPane(tab.id, ...at)
  } catch { /* stays UNAVAILABLE */ }
  if (res.ok && !res.window) dispatch(relayPaneOpened(tab))
  return res
}

const NO_TABS: RelayTab[] = []
const NO_IDS: string[] = []

/** The relay tabs, and picking or closing one. Picking a tab the warm cap closed
 *  opens its pane again; a refusal drops the tab and says why. */
export function useRelayTabs(): { tabs: RelayTab[]; select: (id: string) => void; close: (id: string) => void } {
  const dispatch = useAppDispatch()
  const tabs = useAppSelector(s => s.instances?.relayTabs ?? NO_TABS)
  const live = useAppSelector(s => s.instances?.relayLive ?? NO_IDS)
  const select = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id)
    const bridge = relayPaneBridge()
    if (!tab || !bridge) return
    if (live.includes(id)) { dispatch(relayPaneOpened(tab)); return }
    void openRelayPane(bridge, tab, dispatch).then(res => {
      if (!res.ok) dispatch(relayPaneClosed({ id, refusal: res.error || 'UNAVAILABLE' }))
      else if (res.window) dispatch(relayPaneClosed({ id }))
    })
  }, [dispatch, tabs, live])
  // An open pane's close comes back as its `closed` event; a closed one's tab just goes.
  const close = useCallback((id: string) => {
    if (live.includes(id)) void relayPaneBridge()?.closePane(id)
    else dispatch(relayPaneClosed({ id }))
  }, [dispatch, live])
  return { tabs, select, close }
}
