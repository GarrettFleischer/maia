import type {
  AdmittedRouteName,
  BotSummary,
  PinMark,
  RouterMessage,
  SidebarRow,
  SidebarSection,
  SubmissionOperationId,
  SuperAgentBackendScope,
  SuperAgentClient,
  TaskDetail,
  TaskPhaseName,
} from '@/api/superAgentTypes'
import { isNonTerminalPhase } from '@/api/superAgentFormat'

export type FixtureSendScript = 'admit' | 'ask' | 'refuse' | 'fail' | 'hold'

export interface FixtureSuperAgentClient extends SuperAgentClient {
  releaseHeldSend(outcome: 'admit' | 'fail'): void
}

let fixtureScopeSequence = 0

interface RowMeta {
  pin: PinMark
  view: 'unopened' | 'open' | 'closed_once'
  home: SidebarSection
}

function seedRows(): SidebarRow[] {
  return [
    {
      task_id: 'task-1',
      title: 'Pin control',
      section: 'completed',
      phase: 'completed',
      summary: 'Ready to review',
      elapsed_ms: 1200,
      criteria_done: 1,
      criteria_total: 1,
      children: [
        {
          task_id: 'child-1',
          title: 'Write the control',
          section: 'working',
          phase: 'running',
          summary: 'Editing',
          elapsed_ms: 400,
          criteria_done: 0,
          criteria_total: 1,
          children: [],
        },
      ],
    },
  ]
}

function walkRows(rows: readonly SidebarRow[], visit: (row: SidebarRow) => void) {
  for (const row of rows) {
    visit(row)
    walkRows(row.children, visit)
  }
}

function findRow(rows: readonly SidebarRow[], taskId: string): SidebarRow | null {
  for (const row of rows) {
    if (row.task_id === taskId) return row
    const child = findRow(row.children, taskId)
    if (child) return child
  }
  return null
}

function replyFor(admitted: AdmittedRouteName): string {
  if (admitted === 'ask') return 'Which task should that change?'
  if (admitted === 'refuse') return 'That message was refused.'
  return 'Admitted.'
}

function detailTemplate(taskId: string): TaskDetail | null {
  if (taskId === 'task-1') {
    return {
      task_id: 'task-1',
      title: 'Pin control',
      original_prompt: 'Add a pin control',
      acceptance_context: 'Pin moves the row and keeps the envelope.',
      transcript: [{ id: 'line-1', author: 'Parent', text: 'Editing the control.' }],
      tool_events: [{ call_id: 'call-1', name: 'edit', summary: 'Updated pin handler' }],
      artifacts: [{ artifact_id: 'art-1', label: 'pin-control.diff' }],
      attempts: [{ attempt_id: 'attempt-1', phase: 'completed', summary: 'Ready to review' }],
      decisions: [{ decision_id: 'decision-1', text: 'Keep one composer.' }],
      criteria: [{ criterion_id: 'criterion-1', text: 'Pin control is visible', mark: 'satisfied' }],
      helpers: [{ task_id: 'child-1', title: 'Write the control' }],
    }
  }
  if (taskId === 'child-1') {
    return {
      task_id: 'child-1',
      title: 'Write the control',
      original_prompt: 'Write the control',
      acceptance_context: 'Helper citation inside Pin control.',
      transcript: [{ id: 'child-line-1', author: 'Helper', text: 'Editing the nested control.' }],
      tool_events: [],
      artifacts: [],
      attempts: [{ attempt_id: 'child-attempt-1', phase: 'running', summary: 'Editing' }],
      decisions: [],
      criteria: [{ criterion_id: 'child-criterion-1', text: 'Control is nested', mark: 'pending' }],
      helpers: [],
    }
  }
  return null
}

function sectionAfterPin(row: SidebarRow, rowMeta: RowMeta): SidebarSection {
  if (rowMeta.pin === 'pinned') return 'pinned'
  if (row.phase === 'cancelled' || row.phase === 'abandoned') return 'archive'
  if (row.phase === 'stopped') return 'needs_you'
  if (row.phase === 'completed' && rowMeta.view === 'closed_once') return 'archive'
  return rowMeta.home
}

function placeAfterHost(row: SidebarRow, rowMeta: RowMeta | undefined, phase: TaskPhaseName) {
  row.phase = phase
  if (!rowMeta || rowMeta.pin === 'pinned') return
  row.section = phase === 'stopped' ? 'needs_you' : 'archive'
}

function holdRow(row: SidebarRow, rowMeta: RowMeta | undefined) {
  if (row.phase === 'stopped' || !isNonTerminalPhase(row.phase)) return
  placeAfterHost(row, rowMeta, 'stopped')
}

function endRow(row: SidebarRow, rowMeta: RowMeta | undefined, phase: 'cancelled' | 'abandoned') {
  if (!isNonTerminalPhase(row.phase)) return
  placeAfterHost(row, rowMeta, phase)
}

export function createFixtureSuperAgentClient(options?: {
  send?: FixtureSendScript
  backendScope?: SuperAgentBackendScope
}): FixtureSuperAgentClient {
  const rows = seedRows()
  const meta = new Map<string, RowMeta>()
  walkRows(rows, (row) => {
    meta.set(row.task_id, { pin: 'unpinned', view: 'unopened', home: row.section })
  })
  const messages: RouterMessage[] = [
    { message_id: 'm-owner-1', role: 'owner', text: 'Can I open this from my phone?' },
    { message_id: 'm-router-1', role: 'router', text: 'Yes. Same UI over Tailscale.' },
  ]
  const transcripts = new Map<string, RouterMessage[]>([['maia', messages]])
  const bots: BotSummary[] = [
    {
      bot_id: 'maia',
      name: 'Maia',
      color: '#6f8f7a',
      instructions: '',
      pinned: true,
      archived: false,
      preview: 'Yes. Same UI over Tailscale.',
      last_message_at: 1_700_000_000_000,
      unread: 0,
      running: true,
      status_line: '',
    },
  ]
  let selected = 'maia'
  let messageCount = messages.length
  let operationCount = 0
  let releaseHeld: ((outcome: 'admit' | 'fail') => void) | null = null
  const script = options?.send ?? 'admit'
  fixtureScopeSequence += 1
  const backendScope =
    options?.backendScope ??
    (`fixture:${fixtureScopeSequence}` as SuperAgentBackendScope)

  const admittedFromScript = (): AdmittedRouteName => {
    if (script === 'ask') return 'ask'
    if (script === 'refuse') return 'refuse'
    return 'admit'
  }

  return {
    dataSource: 'fixture',
    backendScope,
    createOperationId() {
      operationCount += 1
      return `00000000-0000-4000-8000-${String(operationCount).padStart(12, '0')}` as SubmissionOperationId
    },
    releaseHeldSend(outcome) {
      const resolve = releaseHeld
      releaseHeld = null
      resolve?.(outcome)
    },
    async sidebar(botId?: string) {
      if (botId && botId !== 'maia') return { rows: [] }
      return { rows: structuredClone(rows) }
    },
    async transcript(botId?: string) {
      const id = botId && botId.length > 0 ? botId : 'maia'
      return { messages: structuredClone(transcripts.get(id) ?? []) }
    },
    async listBots() {
      return { bots: structuredClone(bots), selected }
    },
    async createBot(input) {
      const bot: BotSummary = {
        bot_id: `bot-${bots.length + 1}`,
        name: input.name.trim(),
        color: ['#d98b5f', '#7aa2c4', '#c47aa2', '#c4b36a'][(bots.length - 1) % 4] ?? '#d98b5f',
        instructions: input.instructions?.trim() ?? '',
        pinned: false,
        archived: false,
        preview: '',
        last_message_at: null,
        unread: 0,
        running: false,
        status_line: '',
      }
      bots.push(bot)
      transcripts.set(bot.bot_id, [])
      selected = bot.bot_id
      return structuredClone(bot)
    },
    async renameBot(botId, name) {
      const bot = bots.find((item) => item.bot_id === botId)
      if (!bot) throw new Error('Unknown bot.')
      bot.name = name.trim()
      return structuredClone(bot)
    },
    async pinBot(botId, pinned) {
      const bot = bots.find((item) => item.bot_id === botId)
      if (!bot) throw new Error('Unknown bot.')
      bot.pinned = pinned
      return structuredClone(bot)
    },
    async archiveBot(botId, archived) {
      const bot = bots.find((item) => item.bot_id === botId)
      if (!bot) throw new Error('Unknown bot.')
      bot.archived = archived
      if (archived) bot.pinned = false
      return structuredClone(bot)
    },
    async deleteBot(botId) {
      if (bots.length < 2) throw new Error('Keep at least one bot.')
      const index = bots.findIndex((item) => item.bot_id === botId)
      if (index < 0) throw new Error('Unknown bot.')
      bots.splice(index, 1)
      transcripts.delete(botId)
      if (selected === botId) selected = bots[0]?.bot_id ?? 'maia'
    },
    async selectBot(botId) {
      selected = botId
    },
    async task(taskId) {
      const row = findRow(rows, taskId)
      const template = detailTemplate(taskId)
      if (!row || !template) throw new Error('Unknown task.')
      const detail: TaskDetail = {
        ...template,
        attempts: template.attempts.map((attempt, index) =>
          index === 0 ? { ...attempt, phase: row.phase, summary: row.summary } : attempt,
        ),
      }
      return structuredClone(detail)
    },
    async send(_operationId, text, _attachmentIds?: readonly string[], botId?: string) {
      if (script === 'fail') throw new Error('Message failed.')
      if (script === 'hold') {
        const outcome = await new Promise<'admit' | 'fail'>((resolve) => {
          releaseHeld = resolve
        })
        if (outcome === 'fail') throw new Error('Message failed.')
      }
      const admitted = admittedFromScript()
      const id = botId && botId.length > 0 ? botId : 'maia'
      const bucket = transcripts.get(id) ?? []
      transcripts.set(id, bucket)
      messageCount += 1
      const messageId = `m-owner-${messageCount}`
      bucket.push({ message_id: messageId, role: 'owner', text })
      messageCount += 1
      const reply = replyFor(admitted)
      bucket.push({ message_id: `m-router-${messageCount}`, role: 'router', text: reply })
      const bot = bots.find((item) => item.bot_id === id)
      if (bot) {
        bot.preview = reply
        bot.last_message_at = Date.now()
        if (selected !== id) bot.unread += 1
      }
      return {
        admission: 'admitted',
        message_id: messageId,
        outcome: { kind: 'routed', route: admitted },
      }
    },
    async pin(taskId, pin) {
      const row = findRow(rows, taskId)
      const rowMeta = meta.get(taskId)
      if (row && rowMeta) {
        rowMeta.pin = pin
        row.section = sectionAfterPin(row, rowMeta)
      }
      return { pin }
    },
    async openDetail(taskId) {
      const rowMeta = meta.get(taskId)
      if (rowMeta) rowMeta.view = 'open'
      return { view: 'open' }
    },
    async closeDetail(taskId) {
      const row = findRow(rows, taskId)
      const rowMeta = meta.get(taskId)
      if (row && rowMeta) {
        rowMeta.view = 'closed_once'
        if (rowMeta.pin !== 'pinned' && row.phase === 'completed') row.section = 'archive'
      }
      return { view: 'closed_once' }
    },
    async insertReference(taskId) {
      return { composer_insert: `task:${taskId} ` }
    },
    async hostCommand(command) {
      if (command.command === 'stop_all') {
        walkRows(rows, (row) => holdRow(row, meta.get(row.task_id)))
        return { phase: 'stopped' }
      }
      const row = findRow(rows, command.task_id)
      if (!row) return { phase: command.command === 'abandon' ? 'abandoned' : 'stopped' }
      const rowMeta = meta.get(command.task_id)
      if (command.command === 'stop') holdRow(row, rowMeta)
      else endRow(row, rowMeta, command.command === 'cancel' ? 'cancelled' : 'abandoned')
      return { phase: row.phase }
    },
  }
}

export function fixtureSuperAgentClient(): FixtureSuperAgentClient {
  return createFixtureSuperAgentClient()
}
