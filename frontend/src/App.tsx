import { useState } from 'react'
import { selectSuperAgentClient } from '@/api/liveSuperAgent'
import { PhoneEntry } from '@/components/remote/PhoneEntry'
import { AppShell } from '@/components/shell/AppShell'
import { MaiaProvider } from '@/hooks/useMaiaState'

export default function App() {
  const [client] = useState(() => selectSuperAgentClient(import.meta.env.MODE, window.location.origin))
  return (
    <MaiaProvider>
      <PhoneEntry origin={window.location.origin}>
        <AppShell client={client} />
      </PhoneEntry>
    </MaiaProvider>
  )
}
