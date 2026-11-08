# Routes

There is no React Router. `frontend/src/main.tsx` mounts `App`, which mounts `AppShell` inside `MaiaProvider`.

| Surface | How it opens | Component |
| --- | --- | --- |
| Onboarding | `onboarding_complete === false` | `frontend/src/components/onboarding/OnboardingView.tsx` |
| Conversation | default center view | `frontend/src/components/shell/ConversationPane.tsx` |
| Settings | Settings button toggles center view | `frontend/src/components/settings/SecuritySettingsPage.tsx` |
| Inspector | docked on desktop, drawer otherwise | `frontend/src/components/inspector/InspectorPanel.tsx` |
| Agents drawer | phone header "Agents" | `frontend/src/components/shell/AgentPhoneDrawer.tsx` |

`frontend/src/App.tsx`:

```tsx
import { MaiaProvider } from '@/hooks/useMaiaState'
import { AppShell } from '@/components/shell/AppShell'

export default function App() {
  return (
    <MaiaProvider>
      <AppShell />
    </MaiaProvider>
  )
}

```

`frontend/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles/mint-ledger.css'

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

```
