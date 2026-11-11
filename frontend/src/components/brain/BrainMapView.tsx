import { useEffect, useState } from 'react'
import { NodeChoiceList } from '@/components/brain/NodeChoiceList'
import {
  brainStatusLine,
  layoutBrainMap,
  validateFactSentence,
  visibleBrainNodes,
  type BrainEdge,
  type BrainIndex,
  type BrainMap,
  type BrainMapClient,
  type BrainMapMode,
  type BrainNode,
  type BrainNodeKind,
} from '@/components/brain/layoutBrainMap'

const ALL_KINDS = new Set<BrainNodeKind>(['fact', 'claim', 'episode', 'lexeme'])
const LAYOUT = { width: 960, height: 640 }

export function BrainMapView({ client }: { client: BrainMapClient }) {
  const [map, setMap] = useState<BrainMap | null>(null)
  const [mode, setMode] = useState<BrainMapMode>('explore')
  const [query, setQuery] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmTrim, setConfirmTrim] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [index, setIndex] = useState<BrainIndex | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null)

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

  const selected = map?.nodes.find((node) => node.id === selectedId) ?? null

  const selectNode = (id: string) => {
    if (id === selectedId) return
    setSelectedId(id)
    setConfirmTrim(false)
    const node = map?.nodes.find((item) => item.id === id)
    setDraft(node?.kind === 'fact' ? (node.sentence ?? '') : '')
  }

  if (error && !map) {
    return <p>{error}</p>
  }
  if (!map) {
    return <p>Loading the brain.</p>
  }
  if (map.nodes.length === 0) {
    return (
      <section className="maia-brain" aria-label="Brain map">
        <div className="maia-brain-toolbar">
          <input
            type="search"
            aria-label="Search the brain"
            placeholder="Search the brain"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p>Nothing has been promoted yet. Episodes remain searchable.</p>
        <BrainStatus
          index={index}
          onExport={
            client.exportMarkdown
              ? () => {
                  void client.exportMarkdown?.().then(
                    (next) => setIndex(next),
                    () => setError('That export was not saved.'),
                  )
                }
              : undefined
          }
        />
      </section>
    )
  }

  const visible = visibleBrainNodes(map, { query, kinds: ALL_KINDS, sessionId })
  const visibleIds = new Set(visible.map((node) => node.id))
  const visibleEdges = map.edges.filter(
    (edge) => visibleIds.has(edge.from_id) && visibleIds.has(edge.to_id),
  )
  const positions = layoutBrainMap(visible, visibleEdges, LAYOUT)
  const sessions = [
    ...new Set(map.nodes.flatMap((node) => (node.session_id === null ? [] : [node.session_id]))),
  ].sort()
  const sentenceError = validateFactSentence(draft)
  const editingFact = mode === 'edit' && selected?.kind === 'fact'

  const save = () => {
    if (!selected || selected.kind !== 'fact' || sentenceError) {
      setError(sentenceError)
      return
    }
    const stored = draft.trim()
    void client.reviseFact(selected.id, stored).then(
      (next) => {
        setMap(next)
        setDraft(stored)
        setError(null)
      },
      () => setError('That edit was not saved.'),
    )
  }

  const remove = () => {
    if (!selected || selected.kind !== 'fact') return
    void client.deleteFact(selected.id).then(
      (next) => {
        setMap(next)
        setSelectedId(null)
        setDraft('')
        setConfirmTrim(false)
        setError(null)
      },
      () => setError('That fact was not removed.'),
    )
  }

  return (
    <section className="maia-brain" aria-label="Brain map">
      <div className="maia-brain-toolbar">
        <input
          type="search"
          aria-label="Search the brain"
          placeholder="Search the brain"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label>
          Session
          <select
            aria-label="Session"
            value={sessionId ?? ''}
            onChange={(event) => setSessionId(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">All sessions</option>
            {sessions.map((session) => (
              <option key={session} value={session}>
                {session}
              </option>
            ))}
          </select>
        </label>
        <div role="radiogroup" aria-label="Brain mode">
          <label>
            <input
              type="radio"
              name="brain-mode"
              checked={mode === 'explore'}
              onChange={() => setMode('explore')}
            />
            Explore
          </label>
          <label>
            <input
              type="radio"
              name="brain-mode"
              checked={mode === 'edit'}
              onChange={() => setMode('edit')}
            />
            Edit
          </label>
        </div>
        <button type="button" className="maia-btn" onClick={() => setZoom((value) => clampZoom(value * 1.15))}>
          Zoom in
        </button>
        <button type="button" className="maia-btn" onClick={() => setZoom((value) => clampZoom(value / 1.15))}>
          Zoom out
        </button>
        <BrainStatus
          index={index}
          onExport={
            client.exportMarkdown
              ? () => {
                  void client.exportMarkdown?.().then(
                    (next) => setIndex(next),
                    () => setError('That export was not saved.'),
                  )
                }
              : undefined
          }
        />
      </div>
      <div className="maia-brain-layout">
        <svg
          className="maia-brain-svg"
          viewBox={`0 0 ${LAYOUT.width} ${LAYOUT.height}`}
          role="img"
          aria-label="Brain graph. The list beside it mirrors every visible node."
          onWheel={(event) => {
            event.preventDefault()
            setZoom((value) => clampZoom(value * (event.deltaY < 0 ? 1.08 : 0.92)))
          }}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return
            setDrag({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y })
          }}
          onPointerMove={(event) => {
            if (!drag) return
            setPan({
              x: drag.panX + event.clientX - drag.x,
              y: drag.panY + event.clientY - drag.y,
            })
          }}
          onPointerUp={() => setDrag(null)}
        >
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {visibleEdges.map((edge) => (
              <GraphEdge key={edgeKey(edge)} edge={edge} positions={positions} />
            ))}
            {visible.map((node) => {
              const point = positions.get(node.id)
              if (!point) return null
              return (
                <GraphNode
                  key={node.id}
                  node={node}
                  x={point.x}
                  y={point.y}
                  selected={node.id === selectedId}
                  onSelect={() => selectNode(node.id)}
                />
              )
            })}
          </g>
        </svg>
        <div className="maia-brain-side">
          <NodeChoiceList
            label="Brain nodes"
            selectedId={selectedId}
            onSelect={selectNode}
            items={visible.map((node) => ({
              id: node.id,
              label: node.label,
              taint: node.taint,
            }))}
          />
          <div className="maia-brain-detail">
            {selected ? (
              <>
                <p className="maia-mono">{selected.id}</p>
                <p>{selected.sentence ?? selected.label}</p>
                <p>
                  {selected.taint ?? 'no taint'} · {selected.session_id ?? 'no session'}
                  {selected.held ? ' · hold' : ''}
                </p>
              </>
            ) : (
              <p>Select a fact, claim, episode, or lexeme.</p>
            )}
            {editingFact ? (
              <>
                <label>
                  Fact sentence
                  <input
                    aria-label="Fact sentence"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </label>
                <button type="button" className="maia-btn maia-btn--primary" onClick={save} disabled={sentenceError !== null}>
                  Save sentence
                </button>
                {confirmTrim ? (
                  <button type="button" className="maia-btn maia-btn--danger" onClick={remove}>
                    Remove this fact
                  </button>
                ) : (
                  <button type="button" className="maia-btn" onClick={() => setConfirmTrim(true)}>
                    Trim fact
                  </button>
                )}
              </>
            ) : null}
            {error ? <p>{error}</p> : null}
          </div>
        </div>
      </div>
    </section>
  )
}

function BrainStatus({ index, onExport }: { index: BrainIndex | null; onExport?: () => void }) {
  if (!index && !onExport) return null
  return (
    <div className="maia-brain-status">
      {index ? <p>{brainStatusLine(index)}</p> : null}
      {onExport ? (
        <button type="button" className="maia-btn" onClick={onExport}>
          Export markdown
        </button>
      ) : null}
    </div>
  )
}

function GraphEdge({
  edge,
  positions,
}: {
  edge: BrainEdge
  positions: ReadonlyMap<string, { x: number; y: number }>
}) {
  const from = positions.get(edge.from_id)
  const to = positions.get(edge.to_id)
  if (!from || !to) return null
  return (
    <line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      stroke="currentColor"
      strokeOpacity={0.35}
    />
  )
}

function GraphNode({
  node,
  x,
  y,
  selected,
  onSelect,
}: {
  node: BrainNode
  x: number
  y: number
  selected: boolean
  onSelect: () => void
}) {
  return (
    <g
      className={selected ? 'maia-brain-node is-selected' : 'maia-brain-node'}
      data-testid={`brain-graph-${node.id}`}
      transform={`translate(${x} ${y})`}
      onClick={onSelect}
    >
      <NodeShape kind={node.kind} />
      {node.taint === 'untrusted' ? (
        <text className="maia-brain-mark" x={14} y={-10}>
          U
        </text>
      ) : null}
      {node.held ? (
        <text className="maia-brain-mark" x={14} y={4}>
          hold
        </text>
      ) : null}
      <text y={node.kind === 'lexeme' ? 22 : 28} textAnchor="middle">
        {shortLabel(node.label)}
      </text>
    </g>
  )
}

function NodeShape({ kind }: { kind: BrainNodeKind }) {
  if (kind === 'lexeme') {
    return <rect x={-7} y={-7} width={14} height={14} transform="rotate(45)" />
  }
  const radius = kind === 'fact' ? 16 : kind === 'claim' ? 10 : 5
  return <circle r={radius} />
}

function shortLabel(label: string): string {
  return label.length > 22 ? `${label.slice(0, 21)}…` : label
}

function edgeKey(edge: BrainEdge): string {
  return `${edge.kind}:${edge.from_kind}:${edge.from_id}:${edge.to_kind}:${edge.to_id}`
}

function clampZoom(value: number): number {
  return Math.min(2.5, Math.max(0.4, value))
}
