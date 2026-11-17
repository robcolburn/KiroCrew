/**
 * RelayCrewPane: the region under the local top bar that a Team Crew pane fills
 * in the desktop app's main window (hooks/useRelayCrewPane.ts has the protocol).
 *
 * An empty element over every row of the local dashboard's grid below the top
 * bar. The Crew itself is a native view the desktop shell lays over this rect,
 * so nothing is drawn here but the page background, which is what shows while a
 * local menu or dialog hides the view. Absolutely placed in its grid area, so it
 * takes no part in the grid's auto-placement.
 *
 * Mounted whenever the shell has the pane bridge, so a click can measure it
 * before any pane exists; it is hidden and lets every click through until a
 * Team Crew is the tab in front. Renders nothing without the bridge.
 */
import { useCallback, useState } from 'react'
import { relayPaneBridge, setRelayPaneRegion } from '../lib/relayCrewPaneBridge'
import { useRelayCrewPaneSync } from '../hooks/useRelayCrewPane'
import { TOPBAR_Z } from '../lib/themeDecorLayer'

function RelayCrewPaneRegion() {
  const [region, setRegion] = useState<HTMLDivElement | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    setRelayPaneRegion(el)
    setRegion(el)
  }, [])
  const { active } = useRelayCrewPaneSync(region)
  const shown = active !== null
  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="relay-crew-pane-region"
      data-active={shown ? 'true' : 'false'}
      className={`absolute inset-0 bg-bg ${shown ? '' : 'invisible pointer-events-none'}`}
      // Above the local content it stands in for, under the top bar and its menus.
      style={{ gridRow: '2 / -1', gridColumn: '1 / -1', zIndex: TOPBAR_Z - 1 }}
    />
  )
}

export default function RelayCrewPane() {
  return relayPaneBridge() ? <RelayCrewPaneRegion /> : null
}
