export type ThemeChoice = 'system' | 'dark' | 'light'

export const THEME_STORAGE_KEY = 'maia.theme'

export function readThemeChoice(stored: string | null): ThemeChoice {
  if (stored === 'system' || stored === 'dark' || stored === 'light') return stored
  return 'dark'
}

export function themeAttribute(choice: ThemeChoice, prefersDark: boolean): 'dark' | 'light' {
  if (choice === 'dark' || choice === 'light') return choice
  return prefersDark ? 'dark' : 'light'
}
