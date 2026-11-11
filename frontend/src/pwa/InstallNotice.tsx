import { useEffect, useState } from 'react'
import { installSettingsLine, isInstalledDisplay } from '@/pwa/installPrompt'

const DISMISS_KEY = 'maia.install.dismissed'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

function readInstalled(): boolean {
  const matches = window.matchMedia?.('(display-mode: standalone)')?.matches ?? false
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return isInstalledDisplay(matches, standalone)
}

export function useInstallOffer() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(readInstalled)
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1')

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setPromptEvent(event as InstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setPromptEvent(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  return {
    installed,
    showBanner: promptEvent !== null && !installed && !dismissed,
    canPrompt: promptEvent !== null && !installed,
    dismiss() {
      sessionStorage.setItem(DISMISS_KEY, '1')
      setDismissed(true)
    },
    async prompt() {
      if (!promptEvent) return
      await promptEvent.prompt()
      setPromptEvent(null)
    },
  }
}

export function InstallBanner({
  onInstall,
  onDismiss,
}: {
  onInstall: () => void
  onDismiss: () => void
}) {
  return (
    <div className="maia-install" role="region" aria-label="Install Maia">
      <p>Add Maia to your home screen.</p>
      <button type="button" className="maia-btn maia-btn--primary" onClick={onInstall}>
        Install
      </button>
      <button type="button" className="maia-btn" onClick={onDismiss}>
        Not now
      </button>
    </div>
  )
}

export function InstallSettings({
  installed,
  canPrompt,
  onInstall,
}: {
  installed: boolean
  canPrompt: boolean
  onInstall: () => void
}) {
  return (
    <section className="maia-settings-section" aria-label="Add to Home screen">
      <h2>Home screen</h2>
      <p>{installSettingsLine(installed)}</p>
      {canPrompt ? (
        <button type="button" className="maia-btn" onClick={onInstall}>
          Install
        </button>
      ) : null}
    </section>
  )
}
