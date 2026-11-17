/**
 * useInstanceShortcuts — ⌘+digit (macOS) / Ctrl+digit (Windows/Linux) jumps
 * between the panes shown in the InstanceTabBar: digit 1 = Local, digit 2 = the
 * first remote instance, and so on — mirroring the tab strip left-to-right,
 * exactly like a native tab switcher. The Team Crews open as panes in this window
 * (instances.relayPanes) number on after the remote instances, in the order they
 * opened. The same mapping serves the chord a Team Crew pane forwards while it
 * holds the keyboard (`useSwitchTabByIndex`, called from useRelayCrewPane).
 *
 * ELECTRON-ONLY by design: in a plain browser ⌘/Ctrl+digit is reserved for
 * browser tab switching (Chromium may not even dispatch the keydown), so the
 * page can never reliably claim it. Binding — and advertising in the shortcuts
 * modal (see groupShortcuts) — is therefore gated on the Electron shell, where
 * no menu accelerator holds these chords and the page genuinely wins them.
 *
 * DUAL CONTEXT — the same hook serves both halves of the pane architecture:
 *  - Top-level dashboard: reads the shared ['instances'] React Query cache and
 *    performs the switch directly, reusing InstanceTabBar.onSelectInstance's
 *    exact semantics (activate immediately; (re)connect only when the pane
 *    isn't warm or its tunnel is down; a failed connect never drops the tab).
 *  - Embedded remote pane (an <iframe> running this same SPA): keyboard focus
 *    lives INSIDE the iframe while the user works there, so the parent's
 *    listener can never hear the chord. The embedded copy binds too, maps the
 *    digit against the parent-relayed `instances.host` model, and posts the
 *    switch up via the SAME `mc-switch-instance` relay the embedded tab bar's
 *    click path uses (validated parent-side in InstancesViewport). Gated on
 *    `host.electron` — the pane itself can't see the shell, so the parent
 *    relays that fact down in the host model.
 *
 * DIGIT RANGE — derived from the INSTANCE_SHORTCUTS registry entries (the
 * single source of truth also rendered by the shortcuts modal), so the chords
 * the modal advertises and the chords this handler claims cannot drift apart.
 *
 * Registered ONCE from the app shell (shell/shortcuts/shellKeyboard.ts). It must
 * NOT live inside InstanceTabBar, which
 * can mount more than once (strip + inline header copies) — that would
 * double-fire every press.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { isInstancesDisabledError } from '../utils/instancesDisabled'
import { useAppDispatch, useAppSelector } from '../store'
import { showRelayPane, type RelayPaneTab } from '../store/instancesSlice'
import { isEmbeddedPane } from '../lib/embedded'
import { isElectron } from '../lib/electron'
import { visibleInstanceTabs } from '../components/InstanceTabBar'
import { useSelectInstance } from './useSelectInstance'
import { postToHost } from '../lib/hostRelay'
import { IS_MAC, SHORTCUTS_ENABLED_KEY, INSTANCE_SHORTCUTS } from './useKeyboardShortcuts'

/** Highest digit the chord claims — exactly the advertised registry entries. */
const MAX_DIGIT = INSTANCE_SHORTCUTS.length

/** ⌘ (mac) / Ctrl (win-linux) + un-shifted digit → 0-based pane index, or -1.
 *  Exactly ONE primary modifier so we never shadow Ctrl+digit chat-nav (mac)
 *  or Alt+digit chat-nav (win/linux). */
function chordIndex(e: KeyboardEvent): number {
  const primary = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary || e.altKey || e.shiftKey) return -1
  const code = e.code
  if (code < 'Digit1' || code > `Digit${MAX_DIGIT}`) return -1
  return parseInt(code.charAt(5)) - 1 // Digit1 -> 0 (Local), Digit2 -> 1, ...
}

export const shortcutsEnabled = () => localStorage.getItem(SHORTCUTS_ENABLED_KEY) !== '0'

/** Stable empty fallback for partial (test) stores. */
const NO_RELAY_PANES: RelayPaneTab[] = []

/**
 * Top-level tab N (0-based: 0 = Local, then the remote instances, then the Team
 * Crew panes) brought forward, exactly as a click on it would. `count` is how many
 * tabs there are; `usable` is false while the remote-instances feature is off and
 * no Team Crew pane is open, which leaves no chord to claim.
 */
export function useSwitchTabByIndex() {
  const dispatch = useAppDispatch()
  const warm = useAppSelector(s => s.instances.warm)
  const relayPanes = useAppSelector(s => s.instances.relayPanes ?? NO_RELAY_PANES)
  const embedded = isEmbeddedPane()
  // Top-level only: share the ['instances'] React Query cache with
  // InstanceTabBar / viewport — same cache entry, not a second network poll.
  const instancesQuery = useQuery({ queryKey: ['instances'], queryFn: () => api.listInstances(), enabled: !embedded && isElectron })
  // Only the feature being off turns the digit chords off. A non-owner 403 leaves
  // no remote tabs, so Digit1 (Local) is the only chord that still matches.
  const forbidden = isInstancesDisabledError(instancesQuery.error)
  const instances = useMemo(() => instancesQuery.data?.instances ?? [], [instancesQuery.data?.instances])
  // Same visibility rule as the bar, so the digit order matches the tabs 1:1.
  const tabInstances = useMemo(() => visibleInstanceTabs(instances, warm), [instances, warm])

  // Top-level select: the SAME shared unit the tab bar's click path uses
  // (useSelectInstance), so keyboard and click semantics cannot drift apart.
  const { selectInstance } = useSelectInstance(instances)

  const selectByIndex = useCallback(
    (idx: number) => {
      if (idx === 0) {
        selectInstance(null)
        return
      }
      const inst = tabInstances[idx - 1]
      if (inst) {
        selectInstance(inst.id)
        return
      }
      const pane = relayPanes[idx - 1 - tabInstances.length]
      if (pane) dispatch(showRelayPane(pane.endpointId))
    },
    [tabInstances, relayPanes, selectInstance, dispatch],
  )
  return {
    selectByIndex,
    count: 1 + tabInstances.length + relayPanes.length,
    usable: !forbidden || relayPanes.length > 0,
  }
}

export function useInstanceShortcuts() {
  const host = useAppSelector(s => s.instances.host)
  const embedded = isEmbeddedPane()
  const { selectByIndex, count, usable } = useSwitchTabByIndex()

  // Embedded select: relay up through the SAME channel as the embedded tab
  // bar's click path (EmbeddedInstanceTabBar). The parent validates the target.
  const relayByIndex = useCallback(
    (idx: number) => {
      if (!host) return false
      const id = idx === 0 ? null : host.tabs[idx - 1]?.id
      if (idx !== 0 && !id) return false
      postToHost({ type: 'mc-switch-instance', v: 1, id })
      return true
    },
    [host],
  )

  const handler = useCallback(
    (e: KeyboardEvent) => {
      // Respect the global shortcuts toggle (read live so a Settings change
      // takes effect without re-registering the listener).
      if (!shortcutsEnabled()) return
      const idx = chordIndex(e)
      if (idx < 0) return
      if (embedded) {
        // Gate on the parent-relayed electron flag; only claim the keystroke
        // when the relay actually has a target for it.
        if (!host?.electron) return
        if (idx > host.tabs.length) return
        if (relayByIndex(idx)) e.preventDefault()
        return
      }
      if (!isElectron || !usable) return
      // Only claim the keystroke when a matching pane exists.
      if (idx >= count) return
      e.preventDefault()
      selectByIndex(idx)
    },
    [embedded, host, relayByIndex, usable, count, selectByIndex],
  )

  useEffect(() => {
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handler])
}
