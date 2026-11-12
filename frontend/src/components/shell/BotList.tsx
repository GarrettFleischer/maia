import { useMemo, useState } from 'react'
import { shortWorkStatus } from '@/api/superAgentFormat'
import type { BotSummary } from '@/api/superAgentTypes'

export function relativeChatTime(at: number | null, now: number): string {
  if (at == null) return ''
  const millis = at < 1_000_000_000_000 ? at * 1000 : at
  const minutes = Math.floor(Math.max(0, now - millis) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function sortBots(bots: readonly BotSummary[]): BotSummary[] {
  return [...bots].sort((left, right) => {
    if (left.archived !== right.archived) return left.archived ? 1 : -1
    if (!left.archived && left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return (right.last_message_at ?? 0) - (left.last_message_at ?? 0)
  })
}

export function BotList({
  bots,
  selectedId,
  now = Date.now(),
  onSelect,
  onCreate,
  onRename,
  onPin,
  onArchive,
  onDelete,
}: {
  bots: readonly BotSummary[]
  selectedId: string
  now?: number
  onSelect: (botId: string) => void
  onCreate: (input: { name: string; instructions: string }) => void
  onRename: (botId: string, name: string) => void
  onPin: (botId: string, pinned: boolean) => void
  onArchive: (botId: string, archived: boolean) => void
  onDelete: (botId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      sortBots(bots).filter((bot) => {
        if (!needle) return true
        return (
          bot.name.toLowerCase().includes(needle) || bot.preview.toLowerCase().includes(needle)
        )
      }),
    [bots, needle],
  )
  const active = visible.filter((bot) => !bot.archived)
  const archived = visible.filter((bot) => bot.archived)
  const canDelete = bots.length > 1

  const submitCreate = () => {
    const next = name.trim()
    if (!next) return
    onCreate({ name: next, instructions: instructions.trim() })
    setName('')
    setInstructions('')
    setCreating(false)
  }

  return (
    <div className="maia-bot-list">
      <div className="maia-bot-tools">
        <input
          aria-label="Search chats"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="maia-btn" aria-label="New bot" onClick={() => setCreating(true)}>
          +
        </button>
      </div>
      {creating ? (
        <form
          className="maia-bot-create"
          role="dialog"
          aria-label="New bot"
          onSubmit={(event) => {
            event.preventDefault()
            submitCreate()
          }}
        >
          <label>
            Name
            <input aria-label="Bot name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Instructions
            <textarea
              aria-label="Standing instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <button type="submit" className="maia-btn">
            Create
          </button>
          <button type="button" className="maia-btn" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      ) : null}
      <ul className="maia-bot-rows" aria-label="Bots">
        {active.map((bot) => (
          <BotRow
            key={bot.bot_id}
            bot={bot}
            selected={bot.bot_id === selectedId}
            now={now}
            menuOpen={menuId === bot.bot_id}
            canDelete={canDelete}
            renaming={renameId === bot.bot_id}
            renameValue={renameValue}
            onSelect={() => onSelect(bot.bot_id)}
            onMenu={() => setMenuId((current) => (current === bot.bot_id ? null : bot.bot_id))}
            onRenameStart={() => {
              setRenameId(bot.bot_id)
              setRenameValue(bot.name)
              setMenuId(null)
            }}
            onRenameValue={setRenameValue}
            onRenameSave={() => {
              const next = renameValue.trim()
              if (next) onRename(bot.bot_id, next)
              setRenameId(null)
            }}
            onPin={() => {
              onPin(bot.bot_id, !bot.pinned)
              setMenuId(null)
            }}
            onArchive={() => {
              onArchive(bot.bot_id, !bot.archived)
              setMenuId(null)
            }}
            onDelete={() => {
              onDelete(bot.bot_id)
              setMenuId(null)
            }}
          />
        ))}
      </ul>
      {archived.length > 0 ? (
        <details className="maia-bot-archived" open={needle.length > 0 ? true : undefined}>
          <summary>Archived</summary>
          <ul aria-label="Archived bots">
            {archived.map((bot) => (
              <BotRow
                key={bot.bot_id}
                bot={bot}
                selected={bot.bot_id === selectedId}
                now={now}
                menuOpen={menuId === bot.bot_id}
                canDelete={canDelete}
                renaming={renameId === bot.bot_id}
                renameValue={renameValue}
                onSelect={() => onSelect(bot.bot_id)}
                onMenu={() => setMenuId((current) => (current === bot.bot_id ? null : bot.bot_id))}
                onRenameStart={() => {
                  setRenameId(bot.bot_id)
                  setRenameValue(bot.name)
                  setMenuId(null)
                }}
                onRenameValue={setRenameValue}
                onRenameSave={() => {
                  const next = renameValue.trim()
                  if (next) onRename(bot.bot_id, next)
                  setRenameId(null)
                }}
                onPin={() => {
                  onPin(bot.bot_id, !bot.pinned)
                  setMenuId(null)
                }}
                onArchive={() => {
                  onArchive(bot.bot_id, false)
                  setMenuId(null)
                }}
                onDelete={() => {
                  onDelete(bot.bot_id)
                  setMenuId(null)
                }}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

function BotRow({
  bot,
  selected,
  now,
  menuOpen,
  canDelete,
  renaming,
  renameValue,
  onSelect,
  onMenu,
  onRenameStart,
  onRenameValue,
  onRenameSave,
  onPin,
  onArchive,
  onDelete,
}: {
  bot: BotSummary
  selected: boolean
  now: number
  menuOpen: boolean
  canDelete: boolean
  renaming: boolean
  renameValue: string
  onSelect: () => void
  onMenu: () => void
  onRenameStart: () => void
  onRenameValue: (value: string) => void
  onRenameSave: () => void
  onPin: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  return (
    <li className={selected ? 'maia-bot-row maia-bot-row--selected' : 'maia-bot-row'}>
      <button type="button" className="maia-bot-open" aria-label={bot.name} aria-current={selected ? 'page' : undefined} onClick={onSelect}>
        <span className="maia-bot-avatar" style={{ background: bot.color }} aria-hidden="true">
          {bot.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="maia-bot-copy">
          <span className="maia-bot-name">{bot.name}</span>
          <span className="maia-bot-preview">{bot.preview}</span>
          {bot.status_line ? <span className="maia-bot-status">{shortWorkStatus(bot.status_line)}</span> : null}
        </span>
        <span className="maia-bot-meta">
          <span>{relativeChatTime(bot.last_message_at, now)}</span>
          {bot.unread > 0 ? <span className="maia-bot-unread">{bot.unread}</span> : null}
          {bot.running ? <span className="maia-bot-dot" aria-label="Running" /> : null}
        </span>
      </button>
      <button type="button" className="maia-bot-more" aria-label={`Actions for ${bot.name}`} aria-expanded={menuOpen} onClick={onMenu}>
        …
      </button>
      {menuOpen ? (
        <div className="maia-bot-menu" role="menu">
          <button type="button" onClick={onRenameStart}>
            Rename
          </button>
          <button type="button" onClick={onPin}>
            {bot.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button type="button" onClick={onArchive}>
            {bot.archived ? 'Restore' : 'Archive'}
          </button>
          {canDelete ? (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete ${bot.name}? This cannot be undone.`)) onDelete()
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
      {renaming ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onRenameSave()
          }}
        >
          <input aria-label={`Rename ${bot.name}`} value={renameValue} onChange={(event) => onRenameValue(event.target.value)} />
          <button type="submit">Save</button>
        </form>
      ) : null}
    </li>
  )
}
