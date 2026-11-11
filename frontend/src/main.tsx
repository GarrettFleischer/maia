import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { readThemeChoice, themeAttribute, THEME_STORAGE_KEY } from '@/theme/documentTheme'
import './styles/mint-ledger.css'

const storedTheme = readThemeChoice(localStorage.getItem(THEME_STORAGE_KEY))
document.documentElement.dataset.theme = themeAttribute(
  storedTheme,
  window.matchMedia('(prefers-color-scheme: dark)').matches,
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}
