import { useEffect, useState } from 'react'
import { Copy, KeyRound } from 'lucide-react'

import { i18nT } from '../i18n/t'
import { copyCode } from '../utils/clipboard'
import { KasLoginEmbedded } from './KasLoginGate'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Btn, Card, IconButton } from './ui'

/** Closes the dialog once the flow reports a working sign-in. */
function CloseWhenSignedIn({ onDone }: { onDone: () => void }) {
  useEffect(() => { onDone() }, [onDone])
  return null
}

/**
 * The one Kiro sign-in dialog: Kiro Crew's own sign-in (the bundled engine's),
 * opened by every surface that offers it. Its body is the shared flow
 * (`KasLoginEmbedded`, driven by `hooks/useKasLogin`): the four choices, the
 * browser wait or the device code, cancel. It closes itself once a sign-in lands.
 * *reauth* opens the choices over a stored sign-in: a switch, or one Kiro refused.
 * Closing it mid-sign-in cancels the pending login (`useKasLoginFlow`).
 */
export function KiroSignInDialog({
  open,
  onOpenChange,
  reauth = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  reauth?: boolean
}) {
  const close = () => onOpenChange(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent maxWidth={440} data-testid="kiro-sign-in-dialog">
        <DialogHeader>
          <DialogTitle>{i18nT('components.kasLogin.sign_in_to_kiro')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <KasLoginEmbedded
            bare
            startInReauth={reauth}
            renderPending={() => null}
            // A switch whose old account could not be removed stays open on its
            // warning, so the person reads it; any other landed sign-in closes it.
            renderAuthenticated={(_status, { replaceWarning }) => (replaceWarning ? null : <CloseWhenSignedIn onDone={close} />)}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The signed-out line with its Sign in button, the one shape every chat surface
 * shows for Kiro Crew's own sign-in: before a first chat and under a failed one.
 * A failed turn's request id sits behind a copy control.
 */
export function KiroSignInStrip({
  title,
  reauth = false,
  requestId,
  testId,
}: {
  title: string
  reauth?: boolean
  requestId?: string
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Card className="mb-0 p-3 md:p-3 w-full min-w-0" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 flex min-w-0 flex-1 items-center gap-2 text-[14px] font-semibold text-text-strong">
          <KeyRound className="lucide-inline text-accent" aria-hidden="true" />
          {title}
        </p>
        {requestId ? (
          <IconButton
            aria-label={i18nT('components.kiroSignInPrompt.copy_request_id')}
            onClick={() => void copyCode(requestId)}
            data-testid="kiro-sign-in-copy-request-id"
          >
            <Copy size={14} aria-hidden="true" />
          </IconButton>
        ) : null}
        <Btn primary onClick={() => setOpen(true)} data-testid="kiro-sign-in-open">
          {i18nT('components.kiroSignInPrompt.sign_in')}
        </Btn>
      </div>
      <KiroSignInDialog open={open} onOpenChange={setOpen} reauth={reauth} />
    </Card>
  )
}

/** The request id a failed row's text carries, for the copy control. */
export function requestIdOf(text: string): string | undefined {
  return /request[_ ]id:\s*([0-9a-f-]{8,})/i.exec(text)?.[1]
}
