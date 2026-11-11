import { useEffect, useMemo, useState } from 'react'
import { countActivity, phoneStopLabel } from '@/api/superAgentFormat'
import type { ConnectionSnapshot, InspectorTurn, SuperAgentClient } from '@/api/superAgentTypes'
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
import { ThemeControl } from '@/components/settings/ThemeControl'
import { keyboardInsetPx } from '@/components/shell/keyboardInset'
import { InstallBanner, InstallSettings, useInstallOffer } from '@/pwa/InstallNotice'
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

function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const apply = () => {
      const inset = keyboardInsetPx(window.innerHeight, viewport.height, viewport.offsetTop)
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`)
    }
    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)
    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      document.documentElement.style.removeProperty('--keyboard-inset')
    }
  }, [])
}

function useLiveConnection(client: SuperAgentClient): ConnectionSnapshot | null {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    const stop = client.subscribeConnection?.((next) => {
      if (alive) setSnapshot(next)
    })
    return () => {
      alive = false
      stop?.()
    }
  }, [client])
  return snapshot
}

function InspectToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="maia-btn" aria-pressed={open} onClick={onToggle}>
      Inspect
    </button>
  )
}

export function AppShell({ client }: { client: SuperAgentClient }) {
  const agent = useSuperAgent(client)
  const dataSource = client.dataSource
  const connection = useLiveConnection(client)
  const install = useInstallOffer()
  useKeyboardInset()
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
  const [factFocus, setFactFocus] = useState<readonly string[]>([])
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
      ? { turns: inspectorTurns, brain: inspectorBrain, focusIds: factFocus }
      : undefined
  const factsUsed = new Map<string, readonly string[]>()
  for (const turn of inspectorTurns) {
    if (turn.used && turn.used.length > 0) factsUsed.set(turn.message_id, turn.used)
  }
  const stopAll = () => {
    if (dataSource === 'fixture') stopFixtureActivity()
    void agent.hostCommand({ command: 'stop_all' })
  }
  const openTask = (taskId: string) => {
    setCenterView('conversation')
    setAgentsDrawerOpen(false)
    void agent.openTask(taskId)
  }

  if (dataSource === 'fixture' && !state.onboarding_complete) {
    return <OnboardingView />
  }

  const activity =
    dataSource === 'fixture'
      ? { running: state.activity.running, needsYou: state.activity.needs_human }
      : countActivity(agent.rows)
  const phoneStop = viewport === 'phone' ? phoneStopLabel(activity) : null
  const inspectToggle =
    viewport === 'tablet' ? (
      <InspectToggle open={inspectorOpen} onToggle={() => setInspectorOpen((open) => !open)} />
    ) : null
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
      <a className="maia-skip" href="#main-content">
        Skip to conversation
      </a>
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
          openTaskId={agent.detail?.task_id ?? null}
          onOpen={openTask}
          onPin={agent.pin}
        />
      ) : (
        <header className="maia-phone-header">
          <strong>{phoneTitle(centerView)}</strong>
          <button type="button" className="maia-btn" onClick={() => setInspectorOpen(true)}>
            Inspect
          </button>
        </header>
      )}
      <main className="maia-main" id="main-content">
        {connection?.phase === 'reconnecting' ? (
          <p className="maia-reconnect" role="status">
            Reconnecting to this computer
            <span className="maia-reconnect-origin">{connection.origin}</span>
          </p>
        ) : null}
        {install.showBanner ? (
          <InstallBanner
            onInstall={() => {
              void install.prompt()
            }}
            onDismiss={install.dismiss}
          />
        ) : null}
        {centerView === 'brain' ? (
          <section
            className={viewport === 'phone' ? 'maia-conversation maia-phone-screen' : 'maia-conversation'}
            aria-label="Brain"
          >
            <header className={inspectToggle ? 'maia-conv-head maia-conv-head--split' : 'maia-conv-head'}>
              <div>
                <h1>Brain</h1>
                <p>All sessions</p>
              </div>
              {inspectToggle}
            </header>
            <div className="maia-main-body">
              <BrainMapView client={brainClient} />
            </div>
          </section>
        ) : centerView === 'settings' ? (
          <section
            className={viewport === 'phone' ? 'maia-conversation maia-phone-screen' : 'maia-conversation'}
            aria-label="Settings"
          >
            <header
              className={
                inspectToggle || viewport === 'phone' ? 'maia-conv-head maia-conv-head--split' : 'maia-conv-head'
              }
            >
              {viewport === 'phone' ? (
                <button type="button" className="maia-btn" onClick={() => setCenterView('conversation')}>
                  Back to chat
                </button>
              ) : null}
              <div>
                <h1>Settings</h1>
                <p>
                  {viewport === 'phone'
                    ? 'This computer · Model connection and MCP transports are read-only here'
                    : 'This computer · Model connection and MCP servers are administered here only'}
                </p>
              </div>
              {inspectToggle}
            </header>
            <div className="maia-main-body">
              <ThemeControl />
              <ModelConnectionSection source={dataSource} editable={viewport !== 'phone'} />
              <McpServersSection source={dataSource} editable={viewport !== 'phone'} />
              {dataSource === 'live' ? <PhoneAccessSection origin={window.location.origin} /> : null}
              <InstallSettings
                installed={install.installed}
                canPrompt={install.canPrompt}
                onInstall={() => {
                  void install.prompt()
                }}
              />
              {dataSource === 'live' ? (
                <p className="maia-field-help">Preview, not connected yet</p>
              ) : (
                <SecuritySettingsPage />
              )}
            </div>
          </section>
        ) : (
          <ConversationPane
            dataSource={dataSource}
            layout={conversationLayout}
            activityLabel={`${activity.running} running · ${activity.needsYou} needs you`}
            onStopAll={stopAll}
            phoneStop={phoneStop}
            headerAction={inspectToggle}
            router={agent}
            factsUsed={factsUsed}
            onInspectFacts={(_messageId, ids) => {
              setFactFocus(ids)
              setInspectorOpen(true)
            }}
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
      {showDesktopRail ? null : (
        <AgentPhoneDrawer
          dataSource={dataSource}
          open={agentsDrawerOpen}
          onClose={() => setAgentsDrawerOpen(false)}
          onOpenBrain={() => setCenterView('brain')}
          onOpenSettings={() => setCenterView('settings')}
          onStopAll={stopAll}
          rows={agent.rows}
          openTaskId={agent.detail?.task_id ?? null}
          onOpen={openTask}
          onPin={agent.pin}
        />
      )}
      {showDesktopRail ? null : (
        <nav className="maia-phone-nav" aria-label="Sections">
          <button
            type="button"
            aria-current={centerView === 'conversation' ? 'page' : undefined}
            onClick={() => setCenterView('conversation')}
          >
            Chat
          </button>
          <button
            type="button"
            aria-label="Open tasks drawer"
            aria-expanded={agentsDrawerOpen}
            onClick={() => setAgentsDrawerOpen(true)}
          >
            Tasks
          </button>
          <button
            type="button"
            aria-current={centerView === 'brain' ? 'page' : undefined}
            onClick={() => setCenterView((view) => toggleCenterView(view, 'brain'))}
          >
            Brain
          </button>
          <button
            type="button"
            aria-current={centerView === 'settings' ? 'page' : undefined}
            onClick={() => setCenterView((view) => toggleCenterView(view, 'settings'))}
          >
            Settings
          </button>
        </nav>
      )}
    </div>
  )
}

function phoneTitle(view: CenterView): string {
  if (view === 'brain') return 'Brain'
  if (view === 'settings') return 'Settings'
  return 'Router'
}
