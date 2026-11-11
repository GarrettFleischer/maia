import { useEffect, useState } from 'react'
import { readThemeChoice, themeAttribute, THEME_STORAGE_KEY, type ThemeChoice } from '@/theme/documentTheme'

const CHOICES: readonly { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? true
}

function applyChoice(choice: ThemeChoice) {
  document.documentElement.dataset.theme = themeAttribute(choice, prefersDark())
}

export function ThemeControl() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice(localStorage.getItem(THEME_STORAGE_KEY)))

  useEffect(() => {
    applyChoice(choice)
    if (choice !== 'system') return
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const onChange = () => applyChoice('system')
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [choice])

  const choose = (next: ThemeChoice) => {
    localStorage.setItem(THEME_STORAGE_KEY, next)
    setChoice(next)
  }

  return (
    <fieldset className="maia-settings-section">
      <legend>Theme</legend>
      <div role="radiogroup" aria-label="Theme">
        {CHOICES.map((entry) => (
          <label key={entry.id} className="maia-choice">
            <input
              type="radio"
              name="maia-theme"
              checked={choice === entry.id}
              onChange={() => choose(entry.id)}
            />
            {entry.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
