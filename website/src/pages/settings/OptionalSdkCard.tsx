import { useMutation } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { SettingsSection, SettingsCard } from '../../components/settings'
import { CopyCommandButton } from '../../components/settingRef/CopyCommandButton'
import { Btn } from '../../components/ui'
import { i18nT } from '../../i18n/t'

/** The optional-SDK fields a channel's config GET reports (see
 *  ``_channel_sdk_status`` in the gateway). */
export interface OptionalSdkStatus {
  sdk_installed?: boolean
  sdk_install_supported?: boolean
  sdk_install_command?: string
  /** The desktop app installs the SDK itself (Feishu only). */
  sdk_install_in_app?: boolean
}

/**
 * The "install the optional SDK" card shared by every channel whose client
 * library ships as an optional extra (Feishu, Teams, WhatsApp).
 *
 * On the desktop app a channel that passes `onInstall` gets an Install button:
 * the gateway lays the SDK down outside the signed app bundle. Elsewhere the
 * command comes from the gateway and names ITS interpreter, because installing
 * into a different environment is the failure this card exists to prevent; a
 * bare `pip install` is never rendered here. Where no install channel exists
 * (bundled interpreter, no pip, PEP 668) the gateway sends no command and the
 * card explains that instead.
 *
 * Strictly `=== false`: an older gateway omits the field entirely, and treating
 * undefined as "missing" would tell every user of one to install a package they
 * may already have.
 */
export function OptionalSdkCard({ channel, packageLabel, status, onInstall, onInstalled }: {
  /** Display name of the channel, e.g. "Feishu". */
  channel: string
  /** Distribution name as the user would type it, e.g. "lark-oapi". */
  packageLabel: string
  status: OptionalSdkStatus
  /** The gateway's own installer, shown where `sdk_install_in_app` is true. */
  onInstall?: () => Promise<unknown>
  /** Called after a successful install, to re-read the channel's status. */
  onInstalled?: () => void
}) {
  const install = useMutation({
    mutationFn: () => (onInstall ? onInstall() : Promise.resolve()),
    onSuccess: () => onInstalled?.(),
  })
  if (status.sdk_installed !== false) return null
  const inApp = status.sdk_install_in_app === true && onInstall !== undefined
  return (
    <SettingsSection title={i18nT('pages.settings.botChannelPanel.sdk_missing', { channel })}>
      <SettingsCard>
        {inApp ? (
          <>
            <div className="flex items-center gap-3">
              <p className="flex-1 text-[13px] text-text m-0">
                {i18nT('pages.settings.botChannelPanel.sdk_install_in_app_body', { channel, package: packageLabel })}
              </p>
              <Btn primary busy={install.isPending} onClick={() => install.mutate()} data-testid="sdk-install-button">
                {install.isPending
                  ? i18nT('pages.settings.botChannelPanel.sdk_installing')
                  : i18nT('pages.settings.botChannelPanel.sdk_install')}
              </Btn>
            </div>
            {install.isError && (
              <p className="text-[13px] text-warn mt-2 mb-0 flex items-start gap-1.5" role="alert">
                <AlertTriangle size={13} className="flex-none mt-0.5" />
                {i18nT('pages.settings.botChannelPanel.sdk_install_failed', { package: packageLabel })}
              </p>
            )}
            <p className="text-[12px] text-muted mt-2 mb-0">
              {i18nT('pages.settings.botChannelPanel.sdk_restart_after_install', { channel })}
            </p>
          </>
        ) : status.sdk_install_supported && status.sdk_install_command ? (
          <>
            <p className="text-[13px] text-text m-0">
              {i18nT('pages.settings.botChannelPanel.sdk_missing_body', { channel, package: packageLabel })}
            </p>
            {/* Copyable verbatim: break-all, never truncated. */}
            <div className="flex items-start gap-2 mt-2 rounded-md border border-border bg-bg-elevated px-3 py-2">
              <code className="flex-1 text-[12px] font-mono text-text break-all" data-testid="sdk-install-command">
                {status.sdk_install_command}
              </code>
              <CopyCommandButton text={status.sdk_install_command} />
            </div>
            <p className="text-[12px] text-muted mt-2 mb-0">
              {i18nT('pages.settings.botChannelPanel.sdk_restart_after_install', { channel })}
            </p>
          </>
        ) : (
          <p className="text-[13px] text-warn m-0 flex items-start gap-1.5">
            <AlertTriangle size={13} className="flex-none mt-0.5" />
            {i18nT('pages.settings.botChannelPanel.sdk_install_unsupported', { package: packageLabel })}
          </p>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
