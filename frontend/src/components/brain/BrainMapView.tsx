import { useEffect, useMemo, useState } from 'react'
import {
  brainStatusLine,
  type BrainIndex,
  type BrainMap,
  type BrainMapClient,
  type BrainNode,
  type BrainSearchHit,
} from '@/components/brain/layoutBrainMap'
import { layoutLabeled } from '@/components/brain/layoutForce'

type View = 'memory' | 'search' | 'review' | 'timeline' | 'graph'

const GROUPS: { title: string; categories: string[] }[] = [
  { title: 'About you', categories: ['person', 'other', ''] },
  { title: 'People', categories: ['person'] },
  { title: 'Places', categories: ['place'] },
  { title: 'Projects & folders', categories: ['project', 'path'] },
  { title: 'Devices', categories: ['device'] },
  { title: 'Preferences & instructions', categories: ['preference', 'decision'] },
]

function groupTitle(node: BrainNode): string {
  const category = node.category ?? ''
  if (category === 'person' && (node.subject ?? 'Owner') !== 'Owner') return 'People'
  if (category === 'place') return 'Places'
  if (category === 'project' || category === 'path') return 'Projects & folders'
  if (category === 'device') return 'Devices'
  if (category === 'preference' || category === 'decision') return 'Preferences & instructions'
  return 'About you'
}

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
  const [undo, setUndo] = useState<string | null>(null)

  const reload = (next: BrainMap) => {
    setMap(next)
    setError(null)
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

  const memory = useMemo(() => {
    const grouped = new Map<string, BrainNode[]>()
    for (const title of GROUPS.map((group) => group.title)) grouped.set(title, [])
    for (const node of facts(map ?? { nodes: [], edges: [] })) {
      const title = groupTitle(node)
      grouped.get(title)?.push(node)
    }
    return grouped
  }, [map])

  if (error && !map) return <p role="alert">{error}</p>
  if (!map) return <p role="status">Loading the brain.</p>

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

  const forget = (node: BrainNode) => {
    const write = node.kind === 'claim' && client.forgetClaim ? client.forgetClaim(node.id) : client.deleteFact(node.id)
    void write.then((next) => {
      reload(next)
      setUndo(node.id)
    }, () => setError('That fact could not be forgotten.'))
  }

  return (
    <section className="maia-brain" aria-label="Memory">
      <div className="maia-brain-toolbar" role="tablist" aria-label="Brain views">
        {(['memory', 'search', 'review', 'timeline', 'graph'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={view === item}
            className="maia-btn"
            onClick={() => setView(item)}
          >
            {item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
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
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {view === 'memory' ? (
        <MemoryList
          grouped={memory}
          empty={facts(map).length === 0}
          editing={editing}
          draft={draft}
          onDraft={setDraft}
          onEdit={(node) => {
            setEditing(node.id)
            setDraft(node.sentence ?? node.label)
          }}
          onSave={saveEdit}
          onForget={forget}
          onSource={setSelected}
        />
      ) : null}
      {view === 'search' ? <SearchResults hits={hits} onSearch={runSearch} /> : null}
      {view === 'review' ? (
        <ReviewList
          nodes={facts(map).filter((node) => (node.confidence_millis ?? 700) < 700)}
          hidden={map.hidden ?? []}
          onApprove={(node) => {
            if (!client.editClaim) return
            void client.editClaim(node.id, node.sentence ?? node.label).then(reload)
          }}
          onReject={forget}
          onRestore={(id) => {
            if (!client.restoreClaim) return
            void client.restoreClaim(id).then(reload)
          }}
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
      {undo ? (
        <p role="status">
          Forgotten.{' '}
          <button
            type="button"
            className="maia-btn"
            onClick={() => {
              if (client.restoreClaim) void client.restoreClaim(undo).then(reload)
              setUndo(null)
            }}
          >
            Undo
          </button>
        </p>
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
  grouped,
  empty,
  editing,
  draft,
  onDraft,
  onEdit,
  onSave,
  onForget,
  onSource,
}: {
  grouped: Map<string, BrainNode[]>
  empty: boolean
  editing: string | null
  draft: string
  onDraft: (value: string) => void
  onEdit: (node: BrainNode) => void
  onSave: (node: BrainNode) => void
  onForget: (node: BrainNode) => void
  onSource: (id: string) => void
}) {
  if (empty) {
    return (
        <p>Nothing has been promoted yet. Episodes remain searchable.</p>
    )
  }
  return (
    <div>
      {[...grouped.entries()].map(([title, nodes]) =>
        nodes.length === 0 ? null : (
          <section key={title} aria-label={title}>
            <h2>{title}</h2>
            <ul className="maia-brain-list">
              {nodes.map((node) => (
                <li key={node.id}>
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
                    <p className="maia-muted">{learned(node)}</p>
                    <div className="maia-brain-actions">
                    <button type="button" className="maia-btn" onClick={() => onEdit(node)}>
                      Edit
                    </button>
                    {editing === node.id ? (
                      <button type="button" className="maia-btn" onClick={() => onSave(node)}>
                        Save sentence
                      </button>
                    ) : null}
                    <button type="button" className="maia-btn" onClick={() => onForget(node)}>
                      Forget
                    </button>
                    <button
                      type="button"
                      className="maia-btn"
                      onClick={() => onSource(node.source_episode ?? node.id)}
                    >
                      View source
                    </button>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  )
}

function SearchResults({ hits, onSearch }: { hits: BrainSearchHit[] | null; onSearch: () => void }) {
  return (
    <div>
      <button type="button" className="maia-btn" onClick={onSearch}>
        Search
      </button>
      {hits === null ? <p>Search uses the same recall Maia uses.</p> : null}
      {hits?.length === 0 ? <p>Nothing matched.</p> : null}
      <ul aria-label="Search results">
        {hits?.map((hit) => (
          <li key={`${hit.kind}-${hit.id}`}>
            <p>{hit.sentence || hit.id}</p>
            {hit.arms.map((arm) => (
              <span key={arm} className="maia-chip">
                {arm}
              </span>
            ))}
          </li>
        ))}
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
}: {
  nodes: BrainNode[]
  hidden: BrainNode[]
  onApprove: (node: BrainNode) => void
  onReject: (node: BrainNode) => void
  onRestore: (id: string) => void
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
            <button type="button" className="maia-btn" onClick={() => onReject(node)}>
              Reject
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
              <button type="button" className="maia-btn" onClick={() => onRestore(node.id)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
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
  const boxes = layoutLabeled(nodes.map((node) => ({ id: node.id, label: node.label })))
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
        <span className="maia-swatch maia-swatch--entity">Entity</span>
        <span className="maia-swatch maia-swatch--claim">Claim</span>
      </p>
      <svg className="maia-brain-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Memory graph">
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
          const label = node?.label ?? box.id
          return (
            <g key={box.id} data-testid={`brain-graph-${box.id}`} opacity={active ? 1 : 0.28}>
              <title>{label}</title>
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={6}
                className={node?.kind === 'entity' ? 'maia-brain-entity' : 'maia-brain-claim'}
                onClick={() => onSelect(box.id)}
              />
              <text x={box.x + 8} y={box.y + 15} onClick={() => onSelect(box.id)}>
                {label.slice(0, 18)}
              </text>
            </g>
          )
        })}
      </svg>
      {chosen ? (
        <aside className="maia-brain-sheet" aria-label="Selected memory">
          <h2>{chosen.label}</h2>
          <p>{chosen.sentence ?? chosen.label}</p>
        </aside>
      ) : null}
    </div>
  )
}
