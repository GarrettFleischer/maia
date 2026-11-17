import { useEffect, useMemo, useState } from 'react'
import {
  brainStatusLine,
  memoryBehindLine,
  type BrainIndex,
  type BrainMap,
  type BrainMapClient,
  type BrainNode,
  type BrainSearchHit,
  type SkillRecord,
  type SkillsCatalog,
} from '@/components/brain/layoutBrainMap'
import {
  GRAPH_LINE_HEIGHT,
  graphDisplayLabel,
  layoutLabeled,
  wrapGraphText,
} from '@/components/brain/layoutForce'
import {
  filterFactsByTag,
  orderSearchHits,
  searchHitAction,
  searchKindLabel,
  tagCounts,
  UNTAGGED,
  type MemoryTag,
  type TagCount,
} from '@/components/brain/memoryTags'

type View = 'memory' | 'skills' | 'search' | 'review' | 'timeline' | 'graph'

const BRAIN_TABS: { id: View; label: string; hint: string }[] = [
  { id: 'memory', label: 'Memory', hint: 'Memory: saved facts' },
  { id: 'skills', label: 'Skills', hint: 'Skills: saved how-tos' },
  { id: 'search', label: 'Search', hint: 'Search the brain' },
  { id: 'review', label: 'Review', hint: 'Review: unsure and hidden facts' },
  { id: 'timeline', label: 'Timeline', hint: 'Timeline: conversations' },
  { id: 'graph', label: 'Graph', hint: 'Graph: how facts connect' },
]

function facts(map: BrainMap): BrainNode[] {
  return map.nodes.filter((node) => node.kind === 'claim' || node.kind === 'fact')
}

function learned(node: BrainNode): string {
  if (node.created_at == null) return 'Learned from a conversation'
  return `Learned ${new Date(node.created_at * 1000).toLocaleDateString()}`
}

export function BrainMapView({ client }: { client: BrainMapClient }) {
  const [map, setMap] = useState<BrainMap | null>(null)
  const [view, setView] = useState<View>('memory')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<BrainSearchHit[] | null>(null)
  const [index, setIndex] = useState<BrainIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [tagName, setTagName] = useState('')
  const [retagId, setRetagId] = useState<string | null>(null)
  const [retagNames, setRetagNames] = useState<string[]>([])
  const [skills, setSkills] = useState<SkillsCatalog | null>(null)
  const [openSkill, setOpenSkill] = useState<SkillRecord | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  const reload = (next: BrainMap) => {
    setMap(next)
    setError(null)
  }

  const reloadSkills = () => {
    if (!client.loadSkills) {
      setSkills({ skills: [], catalog_tokens: 0 })
      return
    }
    void client.loadSkills().then(
      (loaded) => setSkills(loaded),
      () => setError('Skills could not be loaded.'),
    )
  }

  useEffect(() => {
    let cancelled = false
    void client.load().then(
      (loaded) => {
        if (!cancelled) setMap(loaded)
      },
      () => {
        if (!cancelled) setError('The brain map could not be loaded.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    if (!client.loadIndex) return
    let cancelled = false
    void client.loadIndex().then(
      (loaded) => {
        if (!cancelled) setIndex(loaded)
      },
      () => {
        if (!cancelled) setIndex(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    if (view !== 'skills') return
    reloadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when opening skills tab
  }, [client, view])

  const allFacts = useMemo(() => facts(map ?? { nodes: [], edges: [] }), [map])
  const catalog = map?.tags ?? []
  const counts = useMemo(() => tagCounts(allFacts, map?.tags ?? []), [allFacts, map])
  const activeFilter = tagFilter !== null && counts.some((item) => item.name === tagFilter) ? tagFilter : null

  if (error && !map) return <p role="alert">{error}</p>
  if (!map) return <p role="status">Loading the brain.</p>

  const behind = memoryBehindLine(map.extraction)

  const runSearch = () => {
    const text = query.trim()
    if (!client.search || text.length === 0) {
      setHits([])
      return
    }
    void client.search(text).then(
      (found) => setHits(found),
      () => setError('Search could not be completed.'),
    )
  }

  const saveEdit = (node: BrainNode) => {
    const sentence = draft.trim()
    if (sentence.length === 0) return
    const write = node.kind === 'claim' && client.editClaim ? client.editClaim(node.id, sentence) : client.reviseFact(node.id, sentence)
    void write.then(reload, () => setError('That edit was not saved.'))
    setEditing(null)
  }

  const remove = (node: BrainNode) => {
    const write = node.kind === 'claim' && client.deleteClaim ? client.deleteClaim(node.id) : client.deleteFact(node.id)
    void write.then(reload, () => setError('That memory could not be deleted.'))
  }

  const hide = (node: BrainNode) => {
    if (!client.forgetClaim) return
    void client.forgetClaim(node.id).then(reload, () => setError('That memory could not be hidden.'))
  }

  return (
    <section className="maia-brain" aria-label="Memory">
      <div className="maia-brain-toolbar maia-brain-tabs" role="tablist" aria-label="Brain views">
        {BRAIN_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-label={item.label}
            title={item.hint}
            aria-selected={view === item.id}
            className="maia-icon-btn maia-brain-tab"
            onClick={() => setView(item.id)}
          >
            <span className={`maia-brain-tab-icon maia-brain-tab-icon--${item.id}`} aria-hidden="true" />
            {view === item.id ? (
              <span className="maia-brain-tab-label" aria-hidden="true">
                {item.label}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {view === 'memory' || view === 'search' ? (
      <div className="maia-brain-toolbar">
        <input
          type="search"
          aria-label="Search the brain"
          placeholder="Search the brain"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setView('search')
              runSearch()
            }
          }}
        />
        <button
          type="button"
          className="maia-icon-btn"
          aria-label="Search"
          title="Search"
          onClick={() => {
            setView('search')
            runSearch()
          }}
        >
          <span className="maia-find-icon" aria-hidden="true" />
        </button>
      </div>
      ) : null}
      {behind ? (
        <div className="maia-brain-behind" data-testid="memory-behind">
          <p role="status">{behind}</p>
          {client.dismissQuarantinedEpisode && (map.extraction?.quarantined_episodes?.length ?? 0) > 0 ? (
            <ul className="maia-brain-quarantine" aria-label="Stuck memory notes">
              {map.extraction!.quarantined_episodes.map((episodeId) => (
                <li key={episodeId}>
                  <button
                    type="button"
                    className="maia-icon-btn"
                    aria-label={`Dismiss stuck note ${episodeId}`}
                    title={`Dismiss stuck note ${episodeId}`}
                    onClick={() => {
                      void client.dismissQuarantinedEpisode?.(episodeId).then(reload, () =>
                        setError('That stuck note could not be dismissed.'),
                      )
                    }}
                  >
                    <span className="maia-remove-icon" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {view === 'memory' ? (
        <MemoryList
          nodes={filterFactsByTag(allFacts, activeFilter)}
          counts={counts}
          total={allFacts.length}
          filter={activeFilter}
          onFilter={setTagFilter}
          catalog={catalog}
          empty={allFacts.length === 0}
          editing={editing}
          draft={draft}
          tagName={tagName}
          retagId={retagId}
          retagNames={retagNames}
          onTagName={setTagName}
          onAddTag={() => {
            const name = tagName.trim()
            if (!name || !client.createTag) return
            void client.createTag(name).then(reload, () => setError('That tag was not added.'))
            setTagName('')
          }}
          onRenameTag={(tag, name) => {
            if (!client.renameTag) return
            void client.renameTag(tag.id, name).then(reload, () => setError('That tag was not renamed.'))
          }}
          onMergeTag={(tag, keepId) => {
            if (!client.mergeTags) return
            void client.mergeTags(keepId, tag.id).then(reload, () => setError('Those tags were not merged.'))
          }}
          onRemoveTag={(tag) => {
            if (!client.removeTag) return
            void client.removeTag(tag.id).then(reload, () => setError('That tag was not removed.'))
          }}
          onDraft={setDraft}
          onEdit={(node) => {
            setEditing(node.id)
            setDraft(node.sentence ?? node.label)
          }}
          onSave={saveEdit}
          onDelete={remove}
          onSource={setSelected}
          onRetagStart={(node) => {
            setRetagId(node.id)
            setRetagNames(node.tags ?? [])
          }}
          onRetagToggle={(name) => {
            setRetagNames((current) =>
              current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
            )
          }}
          onRetagSave={(node) => {
            if (!client.setClaimTags) return
            void client.setClaimTags(node.id, retagNames).then(reload, () => setError('Those tags were not saved.'))
            setRetagId(null)
          }}
        />
      ) : null}
      {view === 'skills' ? (
        <SkillsList
          catalog={skills}
          open={openSkill}
          onOpen={setOpenSkill}
          onDelete={(skillId) => {
            if (!client.deleteSkill) return
            void client.deleteSkill(skillId).then(
              (next) => {
                setSkills(next)
                setOpenSkill(null)
              },
              () => setError('That skill was not deleted.'),
            )
          }}
        />
      ) : null}
      {view === 'search' ? (
        <SearchResults
          hits={hits}
          onOpenFact={(id) => {
            const node = facts(map).find((item) => item.id === id)
            if (!node) return
            setTagFilter(null)
            setView('memory')
            setEditing(node.id)
            setDraft(node.sentence ?? node.label)
          }}
          onViewSource={(id) => {
            setSelected(id)
            setView('timeline')
          }}
        />
      ) : null}
      {view === 'review' ? (
        <ReviewList
          nodes={facts(map).filter((node) => (node.confidence_millis ?? 700) < 700)}
          hidden={map.hidden ?? []}
          onApprove={(node) => {
            if (!client.confirmClaim) return
            void client.confirmClaim(node.id).then(reload)
          }}
          onReject={hide}
          onRestore={(id) => {
            if (!client.restoreClaim) return
            void client.restoreClaim(id).then(reload)
          }}
          onDelete={remove}
        />
      ) : null}
      {view === 'timeline' ? <Timeline map={map} /> : null}
      {view === 'graph' ? (
        <Graph
          nodes={map.nodes.filter((node) => node.kind === 'entity' || node.kind === 'claim')}
          edges={map.edges}
          selected={selected}
          onSelect={setSelected}
        />
      ) : null}
      <details className="maia-brain-settings">
        <summary>Settings / Sync</summary>
        {index ? <p>{brainStatusLine(index)}</p> : <p>No markdown export yet.</p>}
        {client.exportMarkdown ? (
          <button
            type="button"
            className="maia-btn"
            onClick={() => {
              void client.exportMarkdown?.().then(
                (next) => setIndex(next),
                () => setError('That export was not saved.'),
              )
            }}
          >
            Export markdown
          </button>
        ) : null}
      </details>
      {selected ? <p>Source: {selected}</p> : null}
    </section>
  )
}

function MemoryList({
  nodes,
  counts,
  total,
  filter,
  onFilter,
  catalog,
  empty,
  editing,
  draft,
  tagName,
  retagId,
  retagNames,
  onTagName,
  onAddTag,
  onRenameTag,
  onMergeTag,
  onRemoveTag,
  onDraft,
  onEdit,
  onSave,
  onDelete,
  onSource,
  onRetagStart,
  onRetagToggle,
  onRetagSave,
}: {
  nodes: BrainNode[]
  counts: TagCount[]
  total: number
  filter: string | null
  onFilter: (tag: string | null) => void
  catalog: MemoryTag[]
  empty: boolean
  editing: string | null
  draft: string
  tagName: string
  retagId: string | null
  retagNames: string[]
  onTagName: (value: string) => void
  onAddTag: () => void
  onRenameTag: (tag: MemoryTag, name: string) => void
  onMergeTag: (tag: MemoryTag, keepId: string) => void
  onRemoveTag: (tag: MemoryTag) => void
  onDraft: (value: string) => void
  onEdit: (node: BrainNode) => void
  onSave: (node: BrainNode) => void
  onDelete: (node: BrainNode) => void
  onSource: (id: string) => void
  onRetagStart: (node: BrainNode) => void
  onRetagToggle: (name: string) => void
  onRetagSave: (node: BrainNode) => void
}) {
  const filterTag = filter === null ? undefined : catalog.find((item) => item.name === filter)
  return (
    <div className="maia-memory">
      <div className="maia-tag-filter" role="group" aria-label="Filter by tag">
        <button
          type="button"
          className="maia-tag-chip"
          aria-pressed={filter === null}
          title="Show every memory"
          onClick={() => onFilter(null)}
        >
          {`All ${total}`}
        </button>
        {counts.map((item) => (
          <button
            key={item.name}
            type="button"
            className="maia-tag-chip"
            aria-pressed={filter === item.name}
            title={item.name === UNTAGGED ? 'Show memories with no tag' : `Show memories tagged ${item.name}`}
            onClick={() => onFilter(filter === item.name ? null : item.name)}
          >
            {`${item.name} ${item.count}`}
          </button>
        ))}
        <form
          className="maia-tag-add"
          onSubmit={(event) => {
            event.preventDefault()
            onAddTag()
          }}
        >
          <input
            aria-label="New tag"
            placeholder="New tag"
            value={tagName}
            onChange={(event) => onTagName(event.target.value)}
          />
          <button type="submit" className="maia-icon-btn" aria-label="Add tag" title="Add tag">
            <span className="maia-plus-icon" aria-hidden="true" />
          </button>
        </form>
      </div>
      {filterTag ? (
        <TagEditor
          key={filterTag.id}
          tag={filterTag}
          catalog={catalog}
          onRename={onRenameTag}
          onMerge={onMergeTag}
          onRemove={onRemoveTag}
        />
      ) : null}
      {empty ? <p>Nothing has been promoted yet. Episodes remain searchable.</p> : null}
      <ul className="maia-brain-list maia-memory-list" aria-label="Memories">
        {nodes.map((node) => (
          <li key={node.id} className="maia-memory-item">
            <article>
              {editing === node.id ? (
                <input
                  aria-label="Fact sentence"
                  value={draft}
                  onChange={(event) => onDraft(event.target.value)}
                />
              ) : (
                <p>{node.sentence ?? node.label}</p>
              )}
              <div className="maia-memory-meta">
                {(node.tags ?? []).length > 0 ? (
                  (node.tags ?? []).map((name) => (
                    <span key={name} className="maia-chip">
                      {name}
                    </span>
                  ))
                ) : (
                  <span className="maia-chip maia-chip--muted">{UNTAGGED}</span>
                )}
                <span className="maia-muted">{learned(node)}</span>
                <div className="maia-brain-actions" role="group" aria-label="Memory actions">
                  {editing === node.id ? (
                    <button
                      type="button"
                      className="maia-icon-btn"
                      aria-label="Save sentence"
                      title="Save sentence"
                      onClick={() => onSave(node)}
                    >
                      <span className="maia-check-icon" aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="maia-icon-btn"
                      aria-label="Edit"
                      title="Edit"
                      onClick={() => onEdit(node)}
                    >
                      <span className="maia-edit-icon" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="maia-icon-btn"
                    aria-label="Tag"
                    title="Tag"
                    aria-expanded={retagId === node.id}
                    onClick={() => onRetagStart(node)}
                  >
                    <span className="maia-tag-icon" aria-hidden="true" />
                  </button>
                  <DeleteButton onDelete={() => onDelete(node)} />
                  <button
                    type="button"
                    className="maia-icon-btn"
                    aria-label="Source"
                    title="Source"
                    onClick={() => onSource(node.source_episode ?? node.id)}
                  >
                    <span className="maia-source-icon" aria-hidden="true" />
                  </button>
                </div>
              </div>
              {retagId === node.id ? (
                <fieldset className="maia-tag-picker">
                  <legend>Tags for this fact</legend>
                  {catalog.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={retagNames.includes(item.name)}
                        onChange={() => onRetagToggle(item.name)}
                      />
                      {item.name}
                    </label>
                  ))}
                  <button
                    type="button"
                    className="maia-icon-btn"
                    aria-label="Save tags"
                    title="Save tags"
                    onClick={() => onRetagSave(node)}
                  >
                    <span className="maia-check-icon" aria-hidden="true" />
                  </button>
                </fieldset>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TagEditor({
  tag,
  catalog,
  onRename,
  onMerge,
  onRemove,
}: {
  tag: MemoryTag
  catalog: readonly MemoryTag[]
  onRename: (tag: MemoryTag, name: string) => void
  onMerge: (tag: MemoryTag, keepId: string) => void
  onRemove: (tag: MemoryTag) => void
}) {
  const [name, setName] = useState(tag.name)
  const [keepId, setKeepId] = useState('')
  const [open, setOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const others = catalog.filter((item) => item.id !== tag.id)
  return (
    <div className={open ? 'maia-tag-edit is-open' : 'maia-tag-edit'}>
      <button
        type="button"
        className="maia-tag-edit-toggle"
        aria-expanded={open}
        aria-label={`Edit tag ${tag.name}`}
        title={`Rename, merge or remove the ${tag.name} tag`}
        onClick={() => {
          setOpen((current) => !current)
          setConfirmRemove(false)
        }}
      >
        Edit tag
      </button>
      {open ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              onRename(tag, name.trim())
            }}
          >
            <input aria-label={`Rename ${tag.name}`} value={name} onChange={(event) => setName(event.target.value)} />
            <button type="submit" className="maia-btn">
              Rename
            </button>
          </form>
          {others.length > 0 ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (keepId) onMerge(tag, keepId)
              }}
            >
              <select aria-label={`Merge ${tag.name} into`} value={keepId} onChange={(event) => setKeepId(event.target.value)}>
                <option value="">Merge into…</option>
                {others.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="maia-btn">
                Merge
              </button>
            </form>
          ) : null}
          {confirmRemove ? (
            <div className="maia-tag-remove-confirm" role="group" aria-label={`Confirm remove ${tag.name}`}>
              <p>{`Remove ${tag.name}? Facts keep their other tags.`}</p>
              <button
                type="button"
                className="maia-btn"
                onClick={() => {
                  setConfirmRemove(false)
                  onRemove(tag)
                }}
              >
                {`Confirm remove ${tag.name}`}
              </button>
              <button type="button" className="maia-btn" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="maia-btn" onClick={() => setConfirmRemove(true)}>
              {`Remove ${tag.name}`}
            </button>
          )}
        </>
      ) : null}
    </div>
  )
}

function SearchResults({
  hits,
  onOpenFact,
  onViewSource,
}: {
  hits: BrainSearchHit[] | null
  onOpenFact: (id: string) => void
  onViewSource: (id: string) => void
}) {
  return (
    <div>
      {hits === null ? <p className="maia-muted">Type a word and press Enter.</p> : null}
      {hits?.length === 0 ? <p>Nothing matched.</p> : null}
      <ul aria-label="Search results">
        {hits
          ? orderSearchHits(hits).map((hit) => {
              const action = searchHitAction(hit.kind)
              return (
                <li key={`${hit.kind}-${hit.id}`}>
                  <p>{hit.sentence || hit.id}</p>
                  <span className="maia-chip">{searchKindLabel(hit.kind)}</span>
                  {action === 'open_fact' ? (
                    <button
                      type="button"
                      className="maia-btn"
                      aria-label="Open fact"
                      onClick={() => onOpenFact(hit.id)}
                    >
                      Open
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="maia-icon-btn"
                      aria-label="View source"
                      title="View source"
                      onClick={() => onViewSource(hit.id)}
                    >
                      <span className="maia-source-icon" aria-hidden="true" />
                    </button>
                  )}
                </li>
              )
            })
          : null}
      </ul>
    </div>
  )
}

function ReviewList({
  nodes,
  hidden,
  onApprove,
  onReject,
  onRestore,
  onDelete,
}: {
  nodes: BrainNode[]
  hidden: BrainNode[]
  onApprove: (node: BrainNode) => void
  onReject: (node: BrainNode) => void
  onRestore: (id: string) => void
  onDelete: (node: BrainNode) => void
}) {
  return (
    <div>
      {nodes.length === 0 ? <p>Nothing is waiting for review.</p> : null}
      <ul aria-label="Review">
        {nodes.map((node) => (
          <li key={node.id}>
            <p>{node.sentence ?? node.label}</p>
            <button type="button" className="maia-btn" onClick={() => onApprove(node)}>
              Approve
            </button>
            <button type="button" className="maia-btn" title="Hide it; it stays under Hidden" onClick={() => onReject(node)}>
              Hide
            </button>
          </li>
        ))}
      </ul>
      <details>
        <summary>Hidden</summary>
        <ul>
          {hidden.map((node) => (
            <li key={node.id}>
              <p>{node.sentence ?? node.label}</p>
              <div className="maia-brain-actions" role="group" aria-label="Hidden memory actions">
                <button type="button" className="maia-btn" onClick={() => onRestore(node.id)}>
                  Restore
                </button>
                <DeleteButton onDelete={() => onDelete(node)} />
              </div>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** Trash icon that asks once before deleting for good. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [asking, setAsking] = useState(false)
  if (asking) {
    return (
      <span className="maia-delete-confirm" role="group" aria-label="Confirm delete">
        <span className="maia-muted">Delete for good?</span>
        <button
          type="button"
          className="maia-btn"
          onClick={() => {
            setAsking(false)
            onDelete()
          }}
        >
          Delete
        </button>
        <button type="button" className="maia-btn" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </span>
    )
  }
  return (
    <button type="button" className="maia-icon-btn" aria-label="Delete" title="Delete" onClick={() => setAsking(true)}>
      <span className="maia-forget-icon" aria-hidden="true" />
    </button>
  )
}

function Timeline({ map }: { map: BrainMap }) {
  const episodes = map.nodes
    .filter((node) => node.kind === 'episode')
    .slice()
    .reverse()
  if (episodes.length === 0) return <p>No conversations have been stored yet.</p>
  return (
    <ol aria-label="Timeline">
      {episodes.map((episode) => {
        const born = facts(map).filter((fact) => fact.source_episode === episode.id)
        return (
          <li key={episode.id}>
            <p>{episode.sentence ?? episode.label}</p>
            {born.map((fact) => (
              <p key={fact.id}>{fact.sentence ?? fact.label}</p>
            ))}
          </li>
        )
      })}
    </ol>
  )
}

function Graph({
  nodes,
  edges,
  selected,
  onSelect,
}: {
  nodes: BrainNode[]
  edges: BrainMap['edges']
  selected: string | null
  onSelect: (id: string) => void
}) {
  const rowLimit =
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 727px)').matches
      ? 368
      : undefined
  const boxes = layoutLabeled(
    nodes.map((node) => ({ id: node.id, label: graphDisplayLabel(node) })),
    rowLimit,
  )
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const neighbours = new Set<string>()
  if (selected) {
    neighbours.add(selected)
    for (const edge of edges) {
      if (edge.from_id === selected) neighbours.add(edge.to_id)
      if (edge.to_id === selected) neighbours.add(edge.from_id)
    }
  }
  const width = Math.max(320, ...boxes.map((box) => box.x + box.w + 24), 320)
  const height = Math.max(180, ...boxes.map((box) => box.y + box.h + 24), 180)
  const chosen = nodes.find((node) => node.id === selected)
  return (
    <div className="maia-brain-graph">
      <p className="maia-muted">
        <span className="maia-swatch maia-swatch--entity">Topic</span>
        <span className="maia-swatch maia-swatch--claim">Memory</span>
      </p>
      <svg
        className="maia-brain-svg"
        viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: width }}
        role="img"
        aria-label="Memory graph"
      >
        {edges.map((edge) => {
          const from = byId.get(edge.from_id)
          const to = byId.get(edge.to_id)
          if (!from || !to) return null
          return (
            <line
              key={`${edge.from_id}-${edge.to_id}-${edge.kind}`}
              x1={from.x + from.w / 2}
              y1={from.y + from.h / 2}
              x2={to.x + to.w / 2}
              y2={to.y + to.h / 2}
              className="maia-brain-edge"
            />
          )
        })}
        {boxes.map((box) => {
          const node = nodes.find((item) => item.id === box.id)
          const active = selected === null || neighbours.has(box.id)
          const full = node?.sentence ?? node?.label ?? box.id
          const lines = wrapGraphText(node ? graphDisplayLabel(node) : box.id)
          return (
            <g key={box.id} data-testid={`brain-graph-${box.id}`} opacity={active ? 1 : 0.28}>
              <title>{full}</title>
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={6}
                className={node?.kind === 'entity' ? 'maia-brain-entity' : 'maia-brain-claim'}
                onClick={() => onSelect(box.id)}
              />
              <text onClick={() => onSelect(box.id)}>
                {lines.map((line, index) => (
                  <tspan key={`${box.id}-${index}`} x={box.x + 8} y={box.y + 14 + index * GRAPH_LINE_HEIGHT}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          )
        })}
      </svg>
      {chosen ? (
        <aside className="maia-brain-sheet" aria-label="Selected memory">
          <h2>{chosen.label}</h2>
          <p>{chosen.sentence ?? chosen.label}</p>
          {(chosen.tags ?? []).length > 0 ? <p>{(chosen.tags ?? []).join(' · ')}</p> : null}
        </aside>
      ) : null}
    </div>
  )
}

function SkillsList({
  catalog,
  open,
  onOpen,
  onDelete,
}: {
  catalog: SkillsCatalog | null
  open: SkillRecord | null
  onOpen: (skill: SkillRecord | null) => void
  onDelete: (skillId: string) => void
}) {
  if (!catalog) return <p role="status">Loading skills.</p>
  if (catalog.skills.length === 0) {
    return <p>No skills yet. Maia saves reusable how-tos here as she learns them.</p>
  }
  return (
    <div>
      <p className="maia-muted" data-testid="skills-catalog-tokens">
        Catalog ≈ {catalog.catalog_tokens} tokens
      </p>
      <ul className="maia-brain-list" aria-label="Skills">
        {catalog.skills.map((skill) => (
          <li key={skill.skill_id}>
            <article>
              <p>
                <code>{skill.skill_id}</code> — {skill.when_to_use}
              </p>
              <div className="maia-brain-actions">
                <button
                  type="button"
                  className="maia-icon-btn"
                  aria-label={`View ${skill.skill_id}`}
                  title="View"
                  onClick={() => onOpen(open?.skill_id === skill.skill_id ? null : skill)}
                >
                  <span className="maia-source-icon" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="maia-icon-btn"
                  aria-label={`Delete ${skill.skill_id}`}
                  title="Delete"
                  onClick={() => onDelete(skill.skill_id)}
                >
                  <span className="maia-forget-icon" aria-hidden="true" />
                </button>
              </div>
              {open?.skill_id === skill.skill_id ? (
                <pre className="maia-muted" data-testid={`skill-body-${skill.skill_id}`}>
                  {skill.body}
                </pre>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </div>
  )
}
