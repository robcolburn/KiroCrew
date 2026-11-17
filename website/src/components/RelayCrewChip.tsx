/**
 * RelayCrewChips: one top-bar chip per Team Crew open as a pane in this window
 * (hooks/useRelayCrewPane.ts), after the instance switcher's own chips.
 *
 * The chip brings its pane forward, or hands the keyboard back to it when it is
 * already in front; the close beside it closes the pane. They are
 * sibling buttons sharing one outline, never a button inside a button. Same
 * shape and active styling as the switcher's chips (InstanceTabBar
 * `SwitcherChip`), with a people icon where an SSH Crew has its tunnel dot: a
 * Team Crew has no tunnel of its own here, and no unread count.
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, X } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '../store'
import { relayPaneClosed, showRelayPane, type RelayPaneTab } from '../store/instancesSlice'
import { focusRelayPane, relayPaneBridge } from '../lib/relayCrewPaneBridge'
import { Btn } from './ui'

const NO_PANES: RelayPaneTab[] = []

function RelayCrewChip({ pane, active }: { pane: RelayPaneTab; active: boolean }) {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const close = useCallback(() => {
    // The chip goes now; the shell's `closed` event, when it comes, is a no-op.
    dispatch(relayPaneClosed(pane.endpointId))
    void relayPaneBridge()?.closePane(pane.endpointId).catch(() => undefined)
  }, [dispatch, pane.endpointId])
  const title = t('components.relayCrews.chip_title', { name: pane.name })
  return (
    <span
      data-testid="relay-crew-chip"
      data-active={active ? 'true' : 'false'}
      className={
        'flex items-center h-6 shrink-0 rounded-md border text-[12px] whitespace-nowrap ' +
        (active ? 'bg-accent-subtle text-accent font-bold border-transparent' : 'border-border text-text')
      }
    >
      <Btn
        className={`h-full gap-1.5 pl-2 pr-1 py-0 border-0 rounded-r-none text-[12px] bg-transparent hover:bg-bg-hover focus-ring ${active ? 'text-accent font-bold' : 'text-text'}`}
        aria-current={active ? 'true' : undefined}
        aria-label={title}
        title={title}
        data-testid="relay-crew-chip-select"
        // The pane already in front changes no state, so its chip hands it the
        // keyboard itself (the click just put it on this chip).
        onClick={() => (active ? focusRelayPane(pane.endpointId) : dispatch(showRelayPane(pane.endpointId)))}
      >
        <Users className="lucide-inline shrink-0" aria-hidden />
        <span className="tb-drop-crew-name truncate max-w-[140px]">{pane.name}</span>
      </Btn>
      <Btn
        className="h-full px-1 py-0 border-0 rounded-l-none text-muted bg-transparent hover:bg-bg-hover hover:text-text focus-ring"
        aria-label={t('components.relayCrews.close_pane', { name: pane.name })}
        title={t('components.relayCrews.close_pane', { name: pane.name })}
        data-testid="relay-crew-chip-close"
        onClick={close}
      >
        <X className="lucide-inline" aria-hidden />
      </Btn>
    </span>
  )
}

export default function RelayCrewChips() {
  const panes = useAppSelector(s => s.instances.relayPanes ?? NO_PANES)
  const active = useAppSelector(s => s.instances.relayActive ?? null)
  if (panes.length === 0) return null
  return (
    <>
      {panes.map(p => <RelayCrewChip key={p.endpointId} pane={p} active={p.endpointId === active} />)}
    </>
  )
}
