/**
 * The lock a Shared Crew teammate sees on what stays the machine owner's
 * (docs/system-specs/modules/shared-crew.md §2 "What a teammate may do", §7
 * "Owner-only locks"): one calm line naming the owner, never an error, a retry,
 * an agent hand-off or a Terminal/CLI step, since nothing the teammate does can
 * open it. A refused write (`OwnerOnlyOrError`) is the exception for the
 * hand-off: it offers the one its surface's own notice offers.
 *
 * Two inputs, both the backend's answer rather than a frontend rule:
 * - "teammate" is `/api/auth/me`'s `teammate` (`useViewerIsTeammate`), decided
 *   by `shared_crew.teammate_access`. Surfaces that would only read and then be
 *   refused render the lock up front (`OwnerOnlyGate`); each such surface is pinned
 *   to the routes it writes in `test/test_owner_only_ui_pins.py`.
 * - a write the backend refuses as owner-only (`isOwnerOnlyRefusal`: `owner_only`
 *   or a relay route limit) renders the lock in place of its error
 *   (`OwnerOnlyOrError`), so a route made owner-only later reads locked with no
 *   frontend change.
 *
 * The owner is named by `owner_label` from `GET /api/shared-crew/mode`, which is
 * the host's machine name, so the copy says "the person at <machine>". The route
 * can be off (Shared Crew preview off) or fail; each line then reads in its
 * generic form ("the Crew's owner"). The notice renders outside a
 * QueryClientProvider too, in its generic form.
 */
import { useContext, type ReactNode } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import ErrorNotice from './ErrorNotice'
import { Lock } from 'lucide-react'
import { i18nT } from '../i18n/t'
import { isOwnerOnlyRefusal } from '../api/apiError'
import { useSharedCrewMode, useViewerIsTeammate } from '../hooks/sharedCrew/useSharedCrew'

/** Each lock's sentence, named and generic. Literal keys, so the static key
 *  scan sees every one (`src/i18n/dynamicKeys.test.ts`). */
const OWNER_ONLY_KEYS = {
  generic: ['sharedCrew.ownerOnly.generic', 'sharedCrew.ownerOnly.generic_generic'],
  admission: ['sharedCrew.ownerOnly.admission', 'sharedCrew.ownerOnly.admission_generic'],
  invites: ['sharedCrew.ownerOnly.invites', 'sharedCrew.ownerOnly.invites_generic'],
  preview: ['sharedCrew.ownerOnly.preview', 'sharedCrew.ownerOnly.preview_generic'],
  secrets: ['sharedCrew.ownerOnly.secrets', 'sharedCrew.ownerOnly.secrets_generic'],
  phone: ['sharedCrew.ownerOnly.phone', 'sharedCrew.ownerOnly.phone_generic'],
  sign_in_link: ['sharedCrew.ownerOnly.sign_in_link', 'sharedCrew.ownerOnly.sign_in_link_generic'],
  webhooks: ['sharedCrew.ownerOnly.webhooks', 'sharedCrew.ownerOnly.webhooks_generic'],
  remote: ['sharedCrew.ownerOnly.remote', 'sharedCrew.ownerOnly.remote_generic'],
  channels: ['sharedCrew.ownerOnly.channels', 'sharedCrew.ownerOnly.channels_generic'],
  channel_row: ['sharedCrew.ownerOnly.channel_row', 'sharedCrew.ownerOnly.channel_row_generic'],
  cron_secrets: ['sharedCrew.ownerOnly.cron_secrets', 'sharedCrew.ownerOnly.cron_secrets_generic'],
  redaction: ['sharedCrew.ownerOnly.redaction', 'sharedCrew.ownerOnly.redaction_generic'],
  reveal: ['sharedCrew.ownerOnly.reveal', 'sharedCrew.ownerOnly.reveal_generic'],
  terminal: ['sharedCrew.ownerOnly.terminal', 'sharedCrew.ownerOnly.terminal_generic'],
} as const

export type OwnerOnlyKind = keyof typeof OWNER_ONLY_KEYS

/** Whether this tab is a Shared Crew teammate (the backend's `teammate`). */
export function useIsTeammate(): boolean {
  return useViewerIsTeammate()
}

/** The host's machine name for a teammate's lock copy, or `null` when the mode
 *  route is off, failed, has not answered or names no one. */
export function useCrewOwnerName(): string | null {
  const teammate = useIsTeammate()
  const mode = useSharedCrewMode(teammate)
  return (teammate && mode.data?.owner_label?.trim()) || null
}

/** The lock's sentence, naming the owner's machine when it is known. */
export function ownerOnlyText(kind: OwnerOnlyKind, owner: string | null): string {
  const [named, generic] = OWNER_ONLY_KEYS[kind]
  return owner ? i18nT(named, { owner }) : i18nT(generic)
}

interface NoticeProps { kind: OwnerOnlyKind; className?: string; testId?: string }

function NoticeLine({ kind, owner, className = '', testId = `owner-only-${kind}` }: NoticeProps & { owner: string | null }) {
  return (
    <p data-testid={testId} className={`flex items-start gap-2 text-[13px] text-muted leading-relaxed ${className}`}>
      <Lock size={13} className="shrink-0 mt-[3px]" aria-hidden />
      <span>{ownerOnlyText(kind, owner)}</span>
    </p>
  )
}

function NamedNoticeLine(props: NoticeProps) {
  return <NoticeLine {...props} owner={useCrewOwnerName()} />
}

/** One muted line with a lock. Names the owner's machine under a
 *  QueryClientProvider, reads generically without one. */
export function OwnerOnlyNotice(props: NoticeProps) {
  const client = useContext(QueryClientContext)
  return client ? <NamedNoticeLine {...props} /> : <NoticeLine {...props} owner={null} />
}

/** `children` for the owner; the lock instead for a teammate. Children are not
 *  mounted for a teammate, so their owner-only reads and writes never run. */
export function OwnerOnlyGate({ kind, children, className }: { kind: OwnerOnlyKind; children: ReactNode; className?: string }) {
  const teammate = useIsTeammate()
  return teammate ? <OwnerOnlyNotice kind={kind} className={className} /> : <>{children}</>
}

/** The agent hand-off a refused write offers. The teammate's own agent runs, so
 *  it can explain the lock and help word a request to the owner; the call site
 *  passes the same `askAgent` / `onHandoff` as its own notice, so a lock next to
 *  an unsaved draft keeps the hand-off off exactly as that notice does. */
interface RefusalHandoff { askAgent?: boolean; askAgentLabel?: string; onHandoff?: () => void }

/** A refused request, worded as the lock: still an `ErrorNotice`, with the
 *  refusal's details and the call site's hand-off, but no retry, since a retry
 *  meets the same refusal. */
export function OwnerOnlyRefusal(props: NoticeProps & RefusalHandoff) {
  const client = useContext(QueryClientContext)
  return client
    ? <NamedOwnerOnlyRefusal {...props} />
    : <OwnerOnlyRefusalLine {...props} owner={null} />
}

function NamedOwnerOnlyRefusal(props: NoticeProps & RefusalHandoff) {
  return <OwnerOnlyRefusalLine {...props} owner={useCrewOwnerName()} />
}

function OwnerOnlyRefusalLine({ kind, owner, className, testId = `owner-only-${kind}`, askAgent = false, askAgentLabel, onHandoff }: NoticeProps & RefusalHandoff & { owner: string | null }) {
  return (
    <ErrorNotice
      variant="inline"
      className={className}
      testId={testId}
      message={ownerOnlyText(kind, owner)}
      askAgent={askAgent}
      askAgentLabel={askAgentLabel}
      onHandoff={onHandoff}
    />
  )
}

/** The lock when `error` is an owner-only refusal, else `children` (the
 *  surface's own `ErrorNotice`). Put on every owner-only write's error path, with
 *  the same `askAgent` / `onHandoff` as that notice. */
export function OwnerOnlyOrError({ error, kind = 'generic', className, testId, askAgent, askAgentLabel, onHandoff, children }: { error: unknown; kind?: OwnerOnlyKind; className?: string; testId?: string; children?: ReactNode } & RefusalHandoff) {
  if (isOwnerOnlyRefusal(error)) return <OwnerOnlyRefusal kind={kind} className={className} testId={testId} askAgent={askAgent} askAgentLabel={askAgentLabel} onHandoff={onHandoff} />
  return <>{children}</>
}
