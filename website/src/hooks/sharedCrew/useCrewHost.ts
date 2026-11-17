/**
 * The machine a teammate's settings copy should name, for the few surfaces
 * that would otherwise say "your device" / "runs locally" about the owner's
 * computer (Security, About, Voice, Computer Use, Skills).
 *
 * `teammate` is true only once the gateway said this tab is NOT the owner
 * (`useViewerIsNotOwner`), so the owner's own view keeps today's copy and never
 * waits on a read. `ownerLabel` is the host's machine name from
 * `GET /api/shared-crew/mode`, read only for a teammate; the route may be off
 * (Shared Crew preview off) or fail, which leaves it `undefined`; a caller
 * then picks its own sentence for an unnamed host ("the Crew's computer"),
 * never a name fragment spliced into one.
 */
import { useSharedCrewMode, useViewerIsNotOwner } from './useSharedCrew'

export interface CrewHost {
  teammate: boolean
  ownerLabel: string | undefined
}

export function useCrewHost(): CrewHost {
  const { notOwner } = useViewerIsNotOwner()
  const mode = useSharedCrewMode(notOwner)
  const label = notOwner ? mode.data?.owner_label?.trim() || undefined : undefined
  return { teammate: notOwner, ownerLabel: label }
}
