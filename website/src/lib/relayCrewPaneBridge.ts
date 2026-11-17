/**
 * The desktop shell's pane bridge (`window.relayCrewAPI`'s pane calls, preload.js)
 * and the one region of this window a Team Crew pane fills. The hooks that drive
 * a pane are in hooks/useRelayCrewPane.ts; this module holds only what the top
 * bar's chip needs too, so the chip does not pull those hooks in.
 */
import type { RelayCrewOpenResult } from '../hooks/useRelayViewerCrews'
import { isEmbeddedPane } from './embedded'
import { isRelayCrewPane, isRelayCrewWindow } from '../utils/offlineReason'

type PaneRect = { x: number; y: number; width: number; height: number }
type PaneViewport = { width: number; height: number }
export type RelayPaneEvent = { type: string; endpointId: string; index: number }

type RelayPaneBridge = {
  openPane: (endpointId: string, rect: PaneRect, viewport: PaneViewport) => Promise<RelayCrewOpenResult>
  setPaneBounds: (endpointId: string, rect: PaneRect, viewport: PaneViewport) => Promise<unknown>
  setPaneOverlay: (endpointId: string, active: boolean) => Promise<unknown>
  setPaneInactive: (endpointId: string, inactive: boolean) => Promise<unknown>
  closePane: (endpointId: string) => Promise<unknown>
  onPaneEvent: (cb: (event: RelayPaneEvent) => void) => () => void
}

/** Read lazily, not at module load, so a test can stub `window.relayCrewAPI` per case.
 *  Only the local dashboard opens a pane. The shell already withholds the bridge
 *  from a window on a remote gateway and gives a relay Crew's page no preload,
 *  and main refuses every window but the main one; this page refuses too when it
 *  is itself a Crew inside a relay pane or window, or an SSH Crew's embedded pane. */
export function relayPaneBridge(): RelayPaneBridge | null {
  if (isEmbeddedPane() || isRelayCrewPane() || isRelayCrewWindow()) return null
  const b = (window as { relayCrewAPI?: Partial<RelayPaneBridge> }).relayCrewAPI
  return typeof b?.openPane === 'function' && typeof b.onPaneEvent === 'function' ? (b as RelayPaneBridge) : null
}

/** The one region a pane fills, set by `RelayCrewPane` while it is mounted. */
let paneRegion: HTMLElement | null = null
export function setRelayPaneRegion(el: HTMLElement | null) {
  paneRegion = el
}

/** A Team Crew opens as a pane here: the shell can, and this window has the region. */
export function relayPaneAvailable(): boolean {
  return relayPaneBridge() !== null && paneRegion !== null
}

export function measureRelayPaneRegion(el: HTMLElement): [PaneRect, PaneViewport] {
  const r = el.getBoundingClientRect()
  return [{ x: r.x, y: r.y, width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }]
}

/** The pane an open just put in front: the shell focused it as it opened, so
 *  the effect that hands the keyboard to the front pane skips it once. Set only
 *  by an open that moves the front pane (an open of the pane already in front
 *  changes no state, so nothing would consume the skip), and cleared whenever
 *  the front pane becomes any other one, Local included. */
let openedInFront: string | null = null

/** Never rejects: the menu shows a refusal under the row, as the window path does. */
export async function openRelayPaneAt(endpointId: string): Promise<RelayCrewOpenResult> {
  const bridge = relayPaneBridge()
  if (!bridge || !paneRegion) return { ok: false, error: 'UNAVAILABLE' }
  const movesFront = frontPane !== endpointId
  try {
    const res = await bridge.openPane(endpointId, ...measureRelayPaneRegion(paneRegion))
    if (res.ok && !res.inWindow && movesFront) openedInFront = endpointId
    return res
  } catch {
    return { ok: false, error: 'UNAVAILABLE' }
  }
}

/** Hand the keyboard to the pane now in front (opening an open pane focuses it
 *  in the shell), unless an open just did. Local focus is dropped either way:
 *  the dashboard under the pane stays mounted, so typing left there would go to
 *  the wrong Crew. */
export function focusRelayPane(endpointId: string): void {
  const el = document.activeElement
  if (el instanceof HTMLElement) el.blur()
  if (openedInFront === endpointId) {
    openedInFront = null
    return
  }
  openedInFront = null
  // A pane whose renewal stopped restarts here first, and the shell focuses it
  // only when that finishes. If another tab came forward meanwhile, the late
  // focus is undone: this pane goes back behind (which hands the keyboard to
  // Local), and a pane now in front takes the keyboard back.
  void openRelayPaneAt(endpointId).then(async () => {
    if (frontPane === endpointId) return
    const bridge = relayPaneBridge()
    await bridge?.setPaneInactive(endpointId, true).catch(() => undefined)
    const front = frontPane
    if (front) focusRelayPane(front)
  })
}

/** Which pane the dashboard has in front (null for Local or another tab). */
let frontPane: string | null = null
export function noteFrontRelayPane(endpointId: string | null): void {
  frontPane = endpointId
  if (openedInFront !== endpointId) openedInFront = null
}
