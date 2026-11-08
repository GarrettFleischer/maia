import type { PinMark, SidebarRow, SuperAgentDataSource } from '@/api/superAgentTypes'
import { countActivity } from '@/api/superAgentFormat'
import { TaskRail } from '@/components/shell/TaskRail'
import { StopAllButton } from '@/components/shell/StopAllButton'
import { useMaiaState } from '@/hooks/useMaiaState'

interface RailTasks {
  dataSource: SuperAgentDataSource
  rows: readonly SidebarRow[]
  onOpen: (taskId: string) => void
  onPin: (taskId: string, pin: PinMark) => void
}

export function AgentRailBody({ dataSource, rows, onOpen, onPin }: RailTasks) {
  const { state } = useMaiaState()
  const counts =
    dataSource === 'fixture'
      ? { running: state.activity.running, needsYou: state.activity.needs_human }
      : countActivity(rows)
  const showActivity = dataSource === 'fixture' || rows.length > 0
  return (
    <>
      <TaskRail rows={rows} onOpen={onOpen} onPin={onPin} />
      {showActivity ? (
        <p className="maia-rail-count" data-testid="activity-counts">
          {counts.running} running · {counts.needsYou} needs you
        </p>
      ) : null}
    </>
  )
}

export function AgentRail({
  dataSource,
  onOpenBrain,
  brainActive,
  onOpenSettings,
  settingsActive,
  onStopAll,
  rows,
  onOpen,
  onPin,
}: RailTasks & {
  onOpenBrain: () => void
  brainActive: boolean
  onOpenSettings: () => void
  settingsActive: boolean
  onStopAll: () => void
}) {
  return (
    <nav className="maia-nav" aria-label="Tasks">
      <div className="maia-rail-top">
        <span className="maia-kicker">Tasks</span>
      </div>
      <div className="maia-nav-scroll">
        <AgentRailBody
          dataSource={dataSource}
          rows={rows}
          onOpen={onOpen}
          onPin={onPin}
        />
      </div>
      <div className="maia-nav-footer">
        <StopAllButton onStop={onStopAll} />
        <button
          type="button"
          className="maia-foot-link"
          onClick={onOpenBrain}
          aria-current={brainActive ? 'page' : undefined}
        >
          Brain
        </button>
        <button
          type="button"
          className="maia-foot-link"
          onClick={onOpenSettings}
          aria-current={settingsActive ? 'page' : undefined}
        >
          Settings
        </button>
      </div>
    </nav>
  )
}
