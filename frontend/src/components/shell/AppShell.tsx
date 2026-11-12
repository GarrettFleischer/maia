import { useEffect, useMemo, useRef, useState } from 'react'
import { chatActivityLabel, countActivity, phoneStopLabel } from '@/api/superAgentFormat'
import { scopeSuperAgentClient } from '@/api/scopeSuperAgent'
import type { BotSummary, ConnectionSnapshot, InspectorTurn, SuperAgentClient } from '@/api/superAgentTypes'
import { liveBrainMapClient } from '@/api/liveBrainMap'
import { memoryBrainMapClient } from '@/api/memoryBrainMap'
import { emptyBrainMap, type BrainMap } from '@/components/brain/layoutBrainMap'
import { BrainMapView } from '@/components/brain/BrainMapView'
import { OnboardingView } from '@/components/onboarding/OnboardingView'
import { InspectorPanel } from '@/components/inspector/InspectorPanel'
import { UnrestrictedBanner } from '@/components/security/UnrestrictedBanner'
import { BotList } from '@/components/shell/BotList'
import { ConversationPane, type ConversationLayout } from '@/components/shell/ConversationPane'
import { StopAllButton } from '@/components/shell/StopAllButton'
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

const FALLBACK_BOT: BotSummary = {
  bot_id: 'maia',
  name: 'Maia',
  color: '#6f8f7a',
  instructions: '',
  pinned: true,
  archived: false,
  preview: '',
  last_message_at: null,
  unread: 0,
  running: false,
  status_line: '',
}

function readStoredBot(): string {
  try {
    return localStorage.getItem('maia.selected-bot') || 'maia'
  } catch {
    return 'maia'
  }
}

export function AppShell({ client }: { client: SuperAgentClient }) {
  const [bots, setBots] = useState<BotSummary[]>([FALLBACK_BOT])
  const [selectedId, setSelectedId] = useState(readStoredBot)
  const picked = useRef(false)
  const storedBot = useRef(readStoredBot())
  useEffect(() => {
    let cancelled = false
    const load = client.listBots
    if (!load) return
    void load()
      .then((catalog) => {
        if (cancelled || catalog.bots.length === 0) return
        setBots(catalog.bots)
        if (picked.current) return
        const known = catalog.bots.some((bot) => bot.bot_id === storedBot.current)
        setSelectedId(known ? storedBot.current : catalog.selected || 'maia')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client])
  const scoped = useMemo(() => scopeSuperAgentClient(client, selectedId), [client, selectedId])
  const agent = useSuperAgent(scoped)
  const selected = bots.find((bot) => bot.bot_id === selectedId) ?? bots[0] ?? FALLBACK_BOT
  const remember = (id: string) => {
    picked.current = true
    setSelectedId(id)
    try {
      localStorage.setItem('maia.selected-bot', id)
    } catch {
      /* the list still switches */
    }
  }
  const choose = (id: string) => {
    remember(id)
    void client.selectBot?.(id)?.catch(() => undefined)
  }
  const dataSource = client.dataSource
  const connection = useLiveConnection(client)
  const install = useInstallOffer()
  useKeyboardInset()
  const stopFixtureActivity = useStopAllAction()
  const { state } = useMaiaState()
  const viewport = useViewportClass()
  const [centerView, setCenterView] = useState<CenterView>('conversation')
  const [phoneChat, setPhoneChat] = useState(false)
  const returnToChat = useRef(false)
  const closePhoneChat = () => setPhoneChat(false)
  const closePhoneChatRef = useRef(closePhoneChat)
  closePhoneChatRef.current = closePhoneChat
  useEffect(() => {
    if (viewport !== 'phone' || !phoneChat) return
    window.history.pushState({ maiaChat: true }, '')
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closePhoneChatRef.current()
    }
    const onPop = () => closePhoneChatRef.current()
    window.addEventListener('keydown', onKey)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('popstate', onPop)
      const marker = window.history.state as { maiaChat?: boolean } | null
      if (marker?.maiaChat) window.history.back()
    }
  }, [phoneChat, viewport])
  const openBot = (id: string) => {
    choose(id)
    if (viewport === 'phone') setPhoneChat(true)
  }
  const createBot = (input: { name: string; instructions: string }) => {
    const localId = `local-${bots.length + 1}`
    const optimistic: BotSummary = {
      ...FALLBACK_BOT,
      bot_id: localId,
      name: input.name,
      color: '#d98b5f',
      instructions: input.instructions,
      pinned: false,
      last_message_at: Date.now(),
    }
    setBots((current) => [...current, optimistic])
    remember(localId)
    if (viewport === 'phone') setPhoneChat(true)
    const save = client.createBot
    if (!save) return
    void save(input)
      .then((saved) => {
        setBots((current) => current.map((bot) => (bot.bot_id === localId ? saved : bot)))
        setSelectedId((current) => (current === localId ? saved.bot_id : current))
        try {
          localStorage.setItem('maia.selected-bot', saved.bot_id)
        } catch {
          /* selection already moved */
        }
        void client.selectBot?.(saved.bot_id)?.catch(() => undefined)
      })
      .catch(() => {
        setBots((current) => current.filter((bot) => bot.bot_id !== localId))
      })
  }
  const replaceBot = (saved: BotSummary) => {
    setBots((current) => current.map((bot) => (bot.bot_id === saved.bot_id ? saved : bot)))
  }
  const brainClient = useMemo(
    () =>
      dataSource === 'fixture'
        ? memoryBrainMapClient()
        : liveBrainMapClient(window.location.origin),
    [dataSource],
  )
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [factFocus, setFactFocus] = useState<readonly string[]>([])
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
    if (viewport === 'phone') setPhoneChat(true)
    void agent.openTask(taskId)
  }
  const showCounts = dataSource === 'fixture' || agent.rows.length > 0
  const activity =
    dataSource === 'fixture'
      ? { running: state.activity.running, needsYou: state.activity.needs_human }
      : countActivity(agent.rows)
  const listedBots = bots.map((bot) => {
    if (bot.bot_id !== selected.bot_id) return bot
    if (activity.needsYou > 0) return { ...bot, status_line: 'Needs you' }
    if (bot.status_line.trim().length > 0) return bot
    if (activity.running > 0 || bot.running) return { ...bot, status_line: 'Working' }
    return bot
  })
  const phoneList = viewport === 'phone' && centerView === 'conversation' && !phoneChat
  const botList = (
    <BotList
      bots={listedBots}
      selectedId={selected.bot_id}
      onSelect={openBot}
      onCreate={createBot}
      onRename={(id, name) => {
        void client.renameBot?.(id, name).then(replaceBot).catch(() => undefined)
      }}
      onPin={(id, pinned) => {
        void client.pinBot?.(id, pinned).then(replaceBot).catch(() => undefined)
      }}
      onArchive={(id, archived) => {
        void client.archiveBot?.(id, archived).then(replaceBot).catch(() => undefined)
      }}
      onDelete={(id) => {
        void client.deleteBot?.(id)
          .then(() => {
            setBots((current) => current.filter((bot) => bot.bot_id !== id))
            if (selectedId === id) choose(bots.find((bot) => bot.bot_id !== id)?.bot_id ?? 'maia')
          })
          .catch(() => undefined)
      }}
    />
  )

  if (dataSource === 'fixture' && !state.onboarding_complete) {
    return <OnboardingView />
  }

  const phoneStop = viewport === 'phone' && !phoneList ? phoneStopLabel(activity) : null
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
        <nav className="maia-nav" aria-label="Chats">
          <div className="maia-nav-scroll">{botList}</div>
          <div className="maia-nav-footer">
            {showCounts ? (
              <p className="maia-rail-count" data-testid="activity-counts">
                {activity.running} running · {activity.needsYou} needs you
              </p>
            ) : null}
            <StopAllButton onStop={stopAll} />
            <button
              type="button"
              className="maia-foot-link"
              onClick={() => setCenterView((view) => toggleCenterView(view, 'brain'))}
              aria-current={centerView === 'brain' ? 'page' : undefined}
            >
              Brain
            </button>
            <button
              type="button"
              className="maia-foot-link"
              onClick={() => setCenterView((view) => toggleCenterView(view, 'settings'))}
              aria-current={centerView === 'settings' ? 'page' : undefined}
            >
              Settings
            </button>
          </div>
        </nav>
      ) : (
        <header className="maia-phone-header">
          {phoneChat && centerView === 'conversation' ? (
            <button type="button" className="maia-btn" onClick={closePhoneChat}>
              Back
            </button>
          ) : null}
          <div className="maia-phone-title">
            <h1>{phoneTitle(centerView, phoneChat, selected.name)}</h1>
            {phoneChat && centerView === 'conversation' ? (
              <span>{`One conversation · ${chatActivityLabel(activity)}`}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="maia-inspect-quiet"
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
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
            {viewport === 'phone' ? null : (
              <header className={inspectToggle ? 'maia-conv-head maia-conv-head--split' : 'maia-conv-head'}>
                <div>
                  <h1>Brain</h1>
                  <p>All sessions</p>
                </div>
                {inspectToggle}
              </header>
            )}
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
                <button
                  type="button"
                  className="maia-btn"
                  style={{ minHeight: 44, minWidth: 44 }}
                  onClick={() => {
                    setCenterView('conversation')
                    setPhoneChat(returnToChat.current)
                  }}
                >
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
                <p className="maia-field-help">Agent security settings are not on this screen.</p>
              ) : (
                <SecuritySettingsPage />
              )}
            </div>
          </section>
        ) : phoneList ? (
          <section className="maia-conversation maia-phone-screen" aria-label="Chats">
            {botList}
          </section>
        ) : (
          <ConversationPane
            dataSource={dataSource}
            layout={conversationLayout}
            activityLabel={chatActivityLabel(activity)}
            onStopAll={stopAll}
            phoneStop={phoneStop}
            headerAction={
              viewport === 'phone' ? (
                <button
                  type="button"
                  className="maia-inspect-quiet"
                  aria-pressed={inspectorOpen}
                  onClick={() => setInspectorOpen((open) => !open)}
                >
                  Inspect
                </button>
              ) : (
                inspectToggle
              )
            }
            router={agent}
            title={selected.name}
            onBack={viewport === 'phone' ? closePhoneChat : undefined}
            tasks={agent.rows}
            onOpenTask={openTask}
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
        <nav className="maia-phone-nav" aria-label="Sections">
          <button
            type="button"
            aria-current={centerView === 'conversation' && !phoneChat ? 'page' : undefined}
            onClick={() => {
              returnToChat.current = false
              setPhoneChat(false)
              setCenterView('conversation')
            }}
          >
            Chats
          </button>
          <button
            type="button"
            aria-current={centerView === 'brain' ? 'page' : undefined}
            onClick={() => {
              returnToChat.current = phoneChat
              setCenterView((view) => toggleCenterView(view, 'brain'))
            }}
          >
            Brain
          </button>
          <button
            type="button"
            aria-current={centerView === 'settings' ? 'page' : undefined}
            onClick={() => {
              returnToChat.current = phoneChat
              setCenterView((view) => toggleCenterView(view, 'settings'))
            }}
          >
            Settings
          </button>
        </nav>
      )}
    </div>
  )
}

function phoneTitle(view: CenterView, chat: boolean, name: string): string {
  if (view === 'brain') return 'Brain'
  if (view === 'settings') return 'Settings'
  return chat ? name : 'Chats'
}
