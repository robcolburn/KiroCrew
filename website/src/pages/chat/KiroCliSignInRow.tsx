import { useState } from 'react'

import SignInCommands, { KiroCliCheckAgain } from '../../components/KiroCliSignInCommands'
import { KiroSignInDialog, KiroSignInStrip } from '../../components/KiroSignInDialog'
import { Btn, Card } from '../../components/ui'
import { useKiroPrerequisite } from '../../hooks/useKiroPrerequisite'
import { i18nT } from '../../i18n/t'

/**
 * A signed-out turn that kiro-cli's own sign-in can fix: one line, then the
 * welcome screen's two kiro-cli sign-in commands and its Check again. Status,
 * commands and re-read are the welcome screen's own pieces
 * (`useKiroPrerequisite`, `KiroCliSignInCommands`), and the shared status decides
 * whether the commands show: only while it says kiro-cli is installed and not
 * signed in, the welcome screen's own condition. A failed read shows the row's
 * own text, which names the same commands.
 *
 * *crewSignIn* is the turn that ran through kiro-cli's relay, which can run on
 * either sign-in: the row also offers the Sign in button that opens the shared
 * dialog, and keeps that button alone once kiro-cli reads signed in.
 */
export default function KiroCliSignInRow({
  fallback,
  crewSignIn = false,
  requestId,
}: {
  fallback: string
  crewSignIn?: boolean
  requestId?: string
}) {
  const { statusQuery, checkAgain, checking } = useKiroPrerequisite({ poll: false })
  const [open, setOpen] = useState(false)
  const status = statusQuery.data
  const signIn = crewSignIn ? (
    <>
      <Btn primary onClick={() => setOpen(true)} data-testid="kiro-sign-in-open">
        {i18nT('components.kiroSignInPrompt.sign_in')}
      </Btn>
      <KiroSignInDialog open={open} onOpenChange={setOpen} reauth />
    </>
  ) : null
  const commandsShow = !!status && status.installed && !status.authenticated
  if (!status) {
    if (!statusQuery.isError) return null
    return (
      <Card className="mb-0 p-3 self-center w-full max-w-full min-w-0" data-testid="error-card" data-kiro-cli-sign-in="true">
        <p className="m-0 text-[13px] leading-5 text-text-strong" style={{ overflowWrap: 'anywhere' }}>{fallback}</p>
        {signIn ? <div className="mt-3">{signIn}</div> : null}
      </Card>
    )
  }
  if (!commandsShow) {
    if (!crewSignIn) return null
    return (
      <div className="self-center w-full max-w-full min-w-0" data-testid="error-card" data-auth-required="true">
        <KiroSignInStrip
          title={i18nT('components.kiroSignInPrompt.keep_title')}
          reauth
          requestId={requestId}
          testId="error-card-sign-in"
        />
      </div>
    )
  }
  return (
    <Card className="mb-0 p-3 self-center w-full max-w-full min-w-0" data-testid="error-card" data-kiro-cli-sign-in="true">
      <p className="m-0 text-[13px] leading-5 text-text-strong">
        {i18nT(crewSignIn ? 'pages.chat.errorCard.kiro_cli_signed_out_or_sign_in' : 'pages.chat.errorCard.kiro_cli_signed_out')}
      </p>
      <div className="mt-2">
        <SignInCommands status={status} compact />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <KiroCliCheckAgain installed busy={checking} onClick={() => void checkAgain()} />
        {signIn}
      </div>
    </Card>
  )
}
