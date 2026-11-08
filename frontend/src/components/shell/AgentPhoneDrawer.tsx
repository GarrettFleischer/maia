import type { PinMark, SidebarRow, SuperAgentDataSource } from '@/api/superAgentTypes'
import { FocusTrap } from '@/components/a11y/FocusTrap'
import { AgentRailBody } from '@/components/shell/AgentRail'
import { StopAllButton } from '@/components/shell/StopAllButton'

export function AgentPhoneDrawer({
  dataSource,
  open,
  onClose,
  onOpenBrain,
  onOpenSettings,
  onStopAll,
  rows,
  onOpen,
  onPin,
}: {
  dataSource: SuperAgentDataSource
  open: boolean
  onClose: () => void
  onOpenBrain: () => void
  onOpenSettings: () => void
  onStopAll: () => void
  rows: readonly SidebarRow[]
  onOpen: (taskId: string) => void
  onPin: (taskId: string, pin: PinMark) => void
}) {
  return (
    <FocusTrap active={open} onClose={onClose} labelId="agents-drawer-title">
      <nav aria-label="Agents">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="agents-drawer-title" style={{ margin: 0, fontSize: 15 }}>
            Agents
          </h2>
          <button type="button" className="maia-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <AgentRailBody
            dataSource={dataSource}
            rows={rows}
            onOpen={onOpen}
            onPin={onPin}
          />
        </div>
        <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
          <StopAllButton onStop={onStopAll} />
          <button
            type="button"
            className="maia-btn"
            onClick={() => {
              onOpenBrain()
              onClose()
            }}
          >
            Brain
          </button>
          <button
            type="button"
            className="maia-btn"
            onClick={() => {
              onOpenSettings()
              onClose()
            }}
          >
            Settings
          </button>
        </div>
      </nav>
    </FocusTrap>
  )
}
