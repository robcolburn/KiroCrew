/**
 * A Team Crew as a pane in the desktop app's main window, below the local top bar.
 *
 * The desktop shell owns the pane: a native view composited over a rectangle of
 * this window (website/electron/relay-crew-window.js `openRelayCrewPane`). The
 * dashboard owns everything the shell cannot see, the same split as the native
 * Browser panel (useNativeBrowser):
 *
 *   1. Where the pane goes. `RelayCrewPane` renders one empty region under the
 *      top bar; its rect (CSS px, with the viewport so main can derive the zoom)
 *      goes to `openPane` and then to `setPaneBounds` on every resize.
 *   2. What covers it. The native view paints above the page, so a local menu,
 *      popover or dialog open anywhere hides it (`setPaneOverlay`) until it closes,
 *      and the keyboard goes back to the pane in front then.
 *   3. Which tab is in front. Local, an SSH Crew or another Team Crew in front
 *      hides it without closing it (`setPaneInactive`), so it stays warm.
 *   4. What the pane tells this page. `closed` (its chip's close, a sign-out, the
 *      Crew's access ending) drops the chip; `chord` is Ctrl/Cmd+digit pressed while
 *      the pane holds the keyboard, which switches tabs as the page's own chord does.
 *
 * Only a click connects. A reload of this page loses the store but not the shell's
 * panes, so the panes this page opened are recorded in sessionStorage and closed
 * on the next load rather than left on screen with no chip, or opened again.
 *
 * Without `openPane` (an older shell) or with no region mounted (a popout window)
 * a Team Crew opens in its own window, as before (`openRelayCrew`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import type { RelayCrewEntry } from '../api/client'
import { useAppDispatch, useAppSelector } from '../store'
import { relayPaneClosed, relayPaneOpened, setActiveId, type RelayPaneTab } from '../store/instancesSlice'
import { openRelayCrew, type RelayCrewOpenResult } from './useRelayViewerCrews'
import { focusRelayPane, measureRelayPaneRegion, noteFrontRelayPane, openRelayPaneAt, relayPaneAvailable, relayPaneBridge } from '../lib/relayCrewPaneBridge'
import { shortcutsEnabled, useSwitchTabByIndex } from './useInstanceShortcuts'
import { INSTANCE_SHORTCUTS } from './useKeyboardShortcuts'

const OPENED_KEY = 'mc-relay-panes-opened'
/** Set once this page load has closed what the last load left open. */
let staleClosed = false
/** Tests only: start a fresh page load. */
export function resetRelayPaneLoadForTest() {
  staleClosed = false
}

function readOpened(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(OPENED_KEY) || '[]') as unknown
    return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeOpened(ids: string[]) {
  try {
    if (ids.length) sessionStorage.setItem(OPENED_KEY, JSON.stringify(ids))
    else sessionStorage.removeItem(OPENED_KEY)
  } catch {
    /* storage off: a reload then leaves the pane for the shell's own close */
  }
}

/** Connect one Team Crew: a pane in this window when it can be, else its own window.
 *  Answers the shell's `{ ok, error }`. Only a click calls this. */
export function useConnectRelayCrew(): (crew: Pick<RelayCrewEntry, 'endpointId' | 'name'>) => Promise<RelayCrewOpenResult> {
  const dispatch = useAppDispatch()
  return useCallback(async crew => {
    if (!relayPaneAvailable()) return openRelayCrew(crew.endpointId)
    const res = await openRelayPaneAt(crew.endpointId)
    if (res.ok && !res.inWindow) dispatch(relayPaneOpened({ endpointId: crew.endpointId, name: crew.name }))
    return res
  }, [dispatch])
}

/** SPA chrome the native view would paint over: useNativeBrowser's selector, plus
 *  open Radix menus and selects, since this pane fills the area under the top bar
 *  where the top bar's own menus drop down. */
export const RELAY_PANE_OVERLAY_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[data-native-overlay],[data-radix-menu-content],[data-radix-select-viewport]'

const NO_PANES: RelayPaneTab[] = []

/**
 * Keeps every open pane in step with this page. Mounted once, by `RelayCrewPane`,
 * which passes its region. Does nothing without the pane bridge.
 */
export function useRelayCrewPaneSync(region: HTMLElement | null) {
  const dispatch = useAppDispatch()
  const panes = useAppSelector(s => s.instances.relayPanes ?? NO_PANES)
  const active = useAppSelector(s => s.instances.relayActive ?? null)
  const bridge = relayPaneBridge()
  const ids = panes.map(p => p.endpointId)
  const idsKey = ids.join('\n')
  const { selectByIndex, count } = useSwitchTabByIndex()

  // A reload left the panes the last load opened on screen: close them, once
  // per load (a remount of the region must not close the panes this load opened).
  useEffect(() => {
    if (!bridge || staleClosed) return
    staleClosed = true
    for (const id of readOpened()) void bridge.closePane(id).catch(() => undefined)
    writeOpened([])
  }, [bridge])
  useEffect(() => {
    if (bridge) writeOpened(idsKey ? idsKey.split('\n') : [])
  }, [bridge, idsKey])

  // The pane's own events. Read through refs, so the subscription is made once.
  const chord = useRef({ selectByIndex, count })
  chord.current = { selectByIndex, count }
  useEffect(() => {
    if (!bridge) return
    return bridge.onPaneEvent(event => {
      if (event.type === 'closed') {
        dispatch(relayPaneClosed(event.endpointId))
        return
      }
      if (event.type !== 'chord' || !shortcutsEnabled()) return
      const { selectByIndex: select, count: tabs } = chord.current
      if (event.index >= 0 && event.index < Math.min(tabs, INSTANCE_SHORTCUTS.length)) select(event.index)
    })
  }, [bridge, dispatch])

  // Where the panes go: the region's rect, whenever it moves or resizes.
  useEffect(() => {
    if (!bridge || !region || !idsKey) return
    const list = idsKey.split('\n')
    const report = () => {
      const [rect, viewport] = measureRelayPaneRegion(region)
      for (const id of list) void bridge.setPaneBounds(id, rect, viewport).catch(() => undefined)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(region)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [bridge, region, idsKey])

  // Which one is in front. Sent for every pane on every change: the shell keeps
  // a pane warm and hidden while inactive, and shows it once both flags are off.
  // Noted with no pane open too, so a change to Local always clears the skip.
  useEffect(() => {
    if (!bridge) return
    noteFrontRelayPane(active)
    if (!idsKey) return
    for (const id of idsKey.split('\n')) void bridge.setPaneInactive(id, id !== active).catch(() => undefined)
  }, [bridge, idsKey, active])
  // With the region gone no pane is in front of this page.
  useEffect(() => {
    if (bridge) return () => noteFrontRelayPane(null)
  }, [bridge])
  // The pane in front takes the keyboard: the Local dashboard under it stays
  // mounted, so focus left there would send typing to the wrong Crew. Opening
  // an open pane focuses it in the shell (relay-crew-open.js `open`).
  useEffect(() => {
    if (bridge && active) focusRelayPane(active)
  }, [bridge, active])

  // What covers it: any local menu, popover or dialog, while it is open.
  const [overlay, setOverlay] = useState(false)
  useEffect(() => {
    if (!bridge || !idsKey) return
    const check = () => setOverlay(document.querySelector(RELAY_PANE_OVERLAY_SELECTOR) !== null)
    check()
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'data-native-overlay'] })
    return () => mo.disconnect()
  }, [bridge, idsKey])
  useEffect(() => {
    if (!bridge || !idsKey) return
    for (const id of idsKey.split('\n')) void bridge.setPaneOverlay(id, overlay).catch(() => undefined)
  }, [bridge, idsKey, overlay])
  // When it closes, the keyboard goes back to the pane in front: the overlay
  // held it, and on close it returns to a Local element under the pane.
  const activeRef = useRef(active)
  activeRef.current = active
  const hadOverlay = useRef(false)
  useEffect(() => {
    const closed = hadOverlay.current && !overlay
    hadOverlay.current = overlay
    if (bridge && closed && activeRef.current) focusRelayPane(activeRef.current)
  }, [bridge, overlay])

  // A local navigation (the top bar's search, a notification, a native menu
  // entry) is about the local Crew, so it brings Local forward. Keyed on the
  // history entry, not the path: selecting the Local chat already in the URL
  // pushes a new entry at the same path, and that is a navigation too.
  // A replace is the page rewriting its own URL (a chat's new title slug),
  // not a navigation, so it leaves the pane in front.
  const { key: entryKey } = useLocation()
  const navType = useNavigationType()
  const lastEntry = useRef(entryKey)
  useEffect(() => {
    if (lastEntry.current === entryKey) return
    lastEntry.current = entryKey
    if (active && navType !== 'REPLACE') dispatch(setActiveId(null))
  }, [entryKey, navType, active, dispatch])

  return { active, ids }
}
