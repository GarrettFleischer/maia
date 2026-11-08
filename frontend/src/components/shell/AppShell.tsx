import { useEffect, useMemo, useState } from 'react'
import { countActivity } from '@/api/superAgentFormat'
import type { InspectorTurn, SuperAgentClient } from '@/api/superAgentTypes'
import { liveBrainMapClient } from '@/api/liveBrainMap'
import { memoryBrainMapClient } from '@/api/memoryBrainMap'
import { emptyBrainMap, type BrainMap } from '@/components/brain/layoutBrainMap'
import { BrainMapView } from '@/components/brain/BrainMapView'
import { OnboardingView } from '@/components/onboarding/OnboardingView'
import { InspectorPanel } from '@/components/inspector/InspectorPanel'
import { UnrestrictedBanner } from '@/components/security/UnrestrictedBanner'
import { AgentPhoneDrawer } from '@/components/shell/AgentPhoneDrawer'
import { AgentRail } from '@/components/shell/AgentRail'
import { ConversationPane, type ConversationLayout } from '@/components/shell/ConversationPane'
import { McpServersSection } from '@/components/settings/McpServersSection'
import { ModelConnectionSection } from '@/components/settings/ModelConnectionSection'
import { PhoneAccessSection } from '@/components/settings/PhoneAccessSection'
import { SecuritySettingsPage } from '@/components/settings/SecuritySettingsPage'
import { useMaiaState } from '@/hooks/useMaiaState'
import { useStopAllAction } from '@/hooks/useStopAllAction'
import { useSuperAgent } from '@/hooks/useSuperAgent'
import { toggleCenterView, type CenterView } from '@/state/centerView'

function viewportKind(phoneMedia: boolean | null, width: number): ConversationLayout | 'desktop' {
  if (phoneMedia === true || width < 728) return 'phone'
  if (width < 1100) return 'tablet'
  return 'desktop'
}

function readViewportKind(): ConversationLayout | 'desktop' {
  const phoneMedia =
    typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 727px)').matches : null
  return viewportKind(phoneMedia, window.innerWidth)
}

function useViewportClass(): ConversationLayout | 'desktop' {
  const [kind, setKind] = useState(readViewportKind)

  useEffect(() => {
    const update = () => setKind(readViewportKind())
    const phone = window.matchMedia?.('(max-width: 727px)')
    const tablet = window.matchMedia?.('(max-width: 1099px)')
    phone?.addEventListener?.('change', update)
    tablet?.addEventListener?.('change', update)
    window.addEventListener('resize', update)
    update()
    return () => {
      phone?.removeEventListener?.('change', update)
      tablet?.removeEventListener?.('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return kind
}

export function AppShell({ client }: { client: SuperAgentClient }) {
  const agent = useSuperAgent(client)
  const dataSource = client.dataSource
  const stopFixtureActivity = useStopAllAction()
  const { state } = useMaiaState()
  const viewport = useViewportClass()
  const [centerView, setCenterView] = useState<CenterView>('conversation')
  const brainClient = useMemo(
    () =>
      dataSource === 'fixture'
        ? memoryBrainMapClient()
        : liveBrainMapClient(window.location.origin),
    [dataSource],
  )
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [agentsDrawerOpen, setAgentsDrawerOpen] = useState(false)
  const [inspectorTurns, setInspectorTurns] = useState<readonly InspectorTurn[]>([])
  const [inspectorBrain, setInspectorBrain] = useState<BrainMap>(emptyBrainMap)
  const messageKey = agent.messages.map((message) => message.message_id).join('\n')
  useEffect(() => {
    if (dataSource !== 'live' || !client.inspector) {
      setInspectorTurns([])
      return
    }
    let cancelled = false
    void client
      .inspector()
      .then((snapshot) => {
        if (!cancelled) setInspectorTurns(snapshot.turns)
      })
      .catch(() => {
        if (!cancelled) setInspectorTurns([])
      })
    return () => {
      cancelled = true
    }
  }, [client, dataSource, messageKey])
  useEffect(() => {
    if (dataSource !== 'live' || inspectorTurns.length === 0) return
    let cancelled = false
    void brainClient
      .load()
      .then((map) => {
        if (!cancelled) setInspectorBrain(map)
      })
      .catch(() => {
        if (!cancelled) setInspectorBrain(emptyBrainMap())
      })
    return () => {
      cancelled = true
    }
  }, [brainClient, dataSource, inspectorTurns.length, messageKey])
  const liveInspector =
    dataSource === 'live' && inspectorTurns.length > 0
      ? { turns: inspectorTurns, brain: inspectorBrain }
      : undefined
  const stopAll = () => {
    if (dataSource === 'fixture') stopFixtureActivity()
    void agent.hostCommand({ command: 'stop_all' })
  }

  if (dataSource === 'fixture' && !state.onboarding_complete) {
    return <OnboardingView />
  }

  const activity =
    dataSource === 'fixture'
      ? { running: state.activity.running, needsYou: state.activity.needs_human }
      : countActivity(agent.rows)
  const showDesktopRail = viewport !== 'phone'
  const conversationLayout: ConversationLayout =
    viewport === 'desktop' ? 'desktop' : viewport === 'tablet' ? 'tablet' : 'phone'

  const shellClass =
    viewport === 'phone'
      ? 'maia-shell maia-shell--phone'
      : viewport === 'tablet'
        ? 'maia-shell maia-shell--tablet'
        : 'maia-shell'

  return (
    <div className={shellClass} data-viewport={viewport} data-testid="app-shell">
      <header className="maia-titlebar" aria-label="Maia">
        <span className="maia-titlebar-word">Maia</span>
      </header>
      {dataSource === 'fixture' ? <UnrestrictedBanner /> : null}
      {showDesktopRail ? (
        <AgentRail
          dataSource={dataSource}
          onOpenBrain={() => setCenterView((view) => toggleCenterView(view, 'brain'))}
          brainActive={centerView === 'brain'}
          onOpenSettings={() => setCenterView((view) => toggleCenterView(view, 'settings'))}
          settingsActive={centerView === 'settings'}
          onStopAll={stopAll}
          rows={agent.rows}
          onOpen={agent.openTask}
          onPin={agent.pin}
        />
      ) : (
        <header className="maia-phone-header">
          <button
            type="button"
            className="maia-btn"
            aria-label="Open agents drawer"
            aria-expanded={agentsDrawerOpen}
            onClick={() => setAgentsDrawerOpen(true)}
          >
            Agents
          </button>
          <strong>Router</strong>
          <div className="maia-phone-header-actions">
            <button type="button" className="maia-btn" onClick={() => setInspectorOpen(true)}>
              Inspect
            </button>
            <button
              type="button"
              className="maia-btn"
              onClick={() => setCenterView((view) => toggleCenterView(view, 'brain'))}
              aria-current={centerView === 'brain' ? 'page' : undefined}
            >
              Brain
            </button>
            <button
              type="button"
              className="maia-btn"
              onClick={() => setCenterView((view) => toggleCenterView(view, 'settings'))}
              aria-current={centerView === 'settings' ? 'page' : undefined}
            >
              Settings
            </button>
          </div>
        </header>
      )}
      <main className="maia-main" id="main-content">
        {centerView === 'brain' ? (
          <section
            className={viewport === 'phone' ? 'maia-conversation maia-phone-screen' : 'maia-conversation'}
            aria-label="Brain"
          >
            <header className="maia-conv-head">
              {viewport === 'phone' ? (
                <button type="button" className="maia-btn" onClick={() => setCenterView('conversation')}>
                  Chat
                </button>
              ) : null}
              <div>
                <h1>Brain</h1>
                <p>All sessions</p>
              </div>
            </header>
            <div className="maia-main-body">
              <BrainMapView client={brainClient} />
            </div>
          </section>
        ) : centerView === 'settings' ? (
          <section className="maia-conversation" aria-label="Settings">
            <header className="maia-conv-head">
              <h1>Settings</h1>
              <p>
                {viewport === 'phone'
                  ? 'This computer · Model connection and MCP transports are read-only here'
                  : 'This computer · Model connection and MCP servers are administered here only'}
              </p>
            </header>
            <div className="maia-main-body">
              <ModelConnectionSection source={dataSource} editable={viewport !== 'phone'} />
              <McpServersSection source={dataSource} editable={viewport !== 'phone'} />
              {dataSource === 'live' ? <PhoneAccessSection origin={window.location.origin} /> : null}
              <SecuritySettingsPage />
            </div>
          </section>
        ) : (
          <ConversationPane
            dataSource={dataSource}
            layout={conversationLayout}
            activityLabel={`${activity.running} running · ${activity.needsYou} needs you`}
            onStopAll={stopAll}
            router={agent}
          />
        )}
      </main>
      {viewport === 'desktop' ? (
        <InspectorPanel
          surface="docked"
          open
          data={dataSource === 'fixture' ? state.inspector : undefined}
          live={liveInspector}
          onClose={() => undefined}
        />
      ) : (
        <InspectorPanel
          surface="drawer"
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          data={dataSource === 'fixture' ? state.inspector : undefined}
          live={liveInspector}
        />
      )}
      {showDesktopRail ? (
        viewport === 'tablet' ? (
          <button
            type="button"
            className="maia-btn"
            style={{ position: 'fixed', top: 12, right: 12, zIndex: 20 }}
            onClick={() => setInspectorOpen(true)}
          >
            Inspect
          </button>
        ) : null
      ) : (
        <AgentPhoneDrawer
          dataSource={dataSource}
          open={agentsDrawerOpen}
          onClose={() => setAgentsDrawerOpen(false)}
          onOpenBrain={() => setCenterView('brain')}
          onOpenSettings={() => setCenterView('settings')}
          onStopAll={stopAll}
          rows={agent.rows}
          onOpen={agent.openTask}
          onPin={agent.pin}
        />
      )}
    </div>
  )
}
