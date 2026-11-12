export type BrainNodeKind = 'fact' | 'claim' | 'episode' | 'lexeme' | 'entity'

export interface BrainNode {
  id: string
  kind: BrainNodeKind
  label: string
  sentence: string | null
  taint: 'trusted' | 'untrusted' | 'owner' | null
  session_id: string | null
  held: boolean
  category?: string
  confidence_millis?: number | null
  created_at?: number | null
  source_episode?: string | null
  status?: string | null
  hidden_reason?: string | null
  subject?: string | null
  entity_kind?: string | null
  tags?: string[]
}

export interface BrainEdge {
  kind: string
  from_kind: string
  from_id: string
  to_kind: string
  to_id: string
}

export interface BrainMap {
  nodes: BrainNode[]
  edges: BrainEdge[]
  hidden?: BrainNode[]
  tags?: { id: string; name: string; role: string }[]
}

export interface BrainSearchHit {
  id: string
  kind: string
  sentence: string
  arms: string[]
}

export type BrainMapMode = 'explore' | 'edit'

export interface BrainFilter {
  query: string
  kinds: ReadonlySet<BrainNodeKind>
  sessionId: string | null
}

export interface BrainPoint {
  x: number
  y: number
}

export interface LayoutSize {
  width: number
  height: number
}

export interface BrainIndex {
  exported_at: number | null
  neuron_count: number
  edge_count: number
  keyword_count: number
  vector_count: number
  graph_count: number
}

export interface BrainMapClient {
  load(): Promise<BrainMap>
  reviseFact(id: string, sentence: string): Promise<BrainMap>
  deleteFact(id: string): Promise<BrainMap>
  loadIndex?(): Promise<BrainIndex>
  exportMarkdown?(): Promise<BrainIndex>
  search?(query: string): Promise<BrainSearchHit[]>
  editClaim?(id: string, sentence: string): Promise<BrainMap>
  forgetClaim?(id: string): Promise<BrainMap>
  restoreClaim?(id: string): Promise<BrainMap>
  createTag?(name: string): Promise<BrainMap>
  renameTag?(id: string, name: string): Promise<BrainMap>
  mergeTags?(keepId: string, dropId: string): Promise<BrainMap>
  removeTag?(id: string): Promise<BrainMap>
  setClaimTags?(id: string, tags: readonly string[]): Promise<BrainMap>
}

export function brainStatusLine(index: BrainIndex): string {
  const exported =
    index.exported_at === null
      ? 'No markdown export yet'
      : `Last export ${index.exported_at} · ${index.neuron_count} notes · ${index.edge_count} edges`
  return `${exported}. Last recall: keyword ${index.keyword_count} · vector ${index.vector_count} · graph ${index.graph_count}.`
}

const KINDS: readonly BrainNodeKind[] = ['fact', 'claim', 'episode', 'lexeme', 'entity']
const KIND_RANK: Record<BrainNodeKind, number> = {
  episode: 0,
  claim: 1,
  fact: 2,
  lexeme: 3,
  entity: 4,
}
const COLUMN_WIDTH = 220
const ROW_HEIGHT = 78
const ORIGIN = 36
const LEXEME_GAP = 28

export function validateFactSentence(sentence: string): string | null {
  if (sentence.trim().length === 0 || sentence.includes('\n') || sentence.includes('\r')) {
    return 'Enter one sentence.'
  }
  return null
}

export function visibleBrainNodes(map: BrainMap, filter: BrainFilter): BrainNode[] {
  const query = filter.query.trim().toLowerCase()
  return map.nodes.filter((node) => nodeIsVisible(node, map, filter, query))
}

export function layoutBrainMap(
  nodes: readonly BrainNode[],
  edges: readonly BrainEdge[],
  size: LayoutSize,
): Map<string, BrainPoint> {
  const placed = placeNodes(nodes, edges)
  return scaleToSize(placed, size)
}

export function parseBrainMap(body: unknown): BrainMap {
  if (!isRecord(body) || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    throw new Error('The brain map could not be read.')
  }
  const nodes = body.nodes.map(parseNode)
  const edges = body.edges.map(parseEdge)
  const hidden = Array.isArray(body.hidden) ? body.hidden.map(parseNode) : []
  const tags = parseCatalog(body.tag_catalog)
  return hidden.length === 0 ? { nodes, edges, tags } : { nodes, edges, hidden, tags }
}

export function emptyBrainMap(): BrainMap {
  return { nodes: [], edges: [] }
}

function nodeIsVisible(node: BrainNode, map: BrainMap, filter: BrainFilter, query: string): boolean {
  if (!filter.kinds.has(node.kind)) return false
  if (!textMatches(node, query)) return false
  if (filter.sessionId === null) return true
  if (node.kind === 'lexeme') return lexemeTouchesSession(node.id, map, filter.sessionId)
  return node.session_id === filter.sessionId
}

function textMatches(node: BrainNode, query: string): boolean {
  if (query.length === 0) return true
  const haystack = `${node.label}\n${node.sentence ?? ''}`.toLowerCase()
  return haystack.includes(query)
}

function lexemeTouchesSession(lexemeId: string, map: BrainMap, sessionId: string): boolean {
  return map.edges.some((edge) => {
    if (edge.kind !== 'lexeme' || edge.to_id !== lexemeId) return false
    const host = map.nodes.find((node) => node.id === edge.from_id)
    return host?.session_id === sessionId
  })
}

function placeNodes(nodes: readonly BrainNode[], edges: readonly BrainEdge[]): Map<string, BrainPoint> {
  const placed = new Map<string, BrainPoint>()
  const sessions = [
    ...new Set(nodes.flatMap((node) => (node.session_id === null ? [] : [node.session_id]))),
  ].sort()
  const columns = new Map<string, BrainNode[]>()
  for (const session of sessions) columns.set(session, [])
  const unscoped: BrainNode[] = []
  for (const node of [...nodes].filter((node) => node.kind !== 'lexeme').sort(compareNodes)) {
    const column = node.session_id === null ? undefined : columns.get(node.session_id)
    if (column) column.push(node)
    else unscoped.push(node)
  }
  sessions.forEach((session, column) => {
    for (const [row, node] of (columns.get(session) ?? []).entries()) {
      placed.set(node.id, point(column, row))
    }
  })
  unscoped.forEach((node, row) => {
    placed.set(node.id, point(sessions.length, row))
  })
  const stacks = new Map<string, number>()
  for (const lexeme of nodes.filter((node) => node.kind === 'lexeme').sort(compareNodes)) {
    const hostId = lexemeHost(lexeme.id, edges, placed)
    if (hostId === null) {
      const row = stacks.get('unplaced') ?? 0
      stacks.set('unplaced', row + 1)
      placed.set(lexeme.id, point(sessions.length + 1, row))
      continue
    }
    const host = placed.get(hostId)
    if (!host) continue
    const stack = stacks.get(hostId) ?? 0
    stacks.set(hostId, stack + 1)
    placed.set(lexeme.id, { x: host.x + LEXEME_GAP + stack * 18, y: host.y + 22 })
  }
  return placed
}

function point(column: number, row: number): BrainPoint {
  return { x: ORIGIN + column * COLUMN_WIDTH, y: ORIGIN + row * ROW_HEIGHT }
}

function lexemeHost(
  lexemeId: string,
  edges: readonly BrainEdge[],
  placed: ReadonlyMap<string, BrainPoint>,
): string | null {
  const hosts = edges
    .filter((edge) => edge.kind === 'lexeme' && edge.to_kind === 'lexeme' && edge.to_id === lexemeId)
    .map((edge) => edge.from_id)
    .filter((id) => placed.has(id))
    .sort()
  return hosts[0] ?? null
}

function compareNodes(left: BrainNode, right: BrainNode): number {
  return KIND_RANK[left.kind] - KIND_RANK[right.kind] || left.id.localeCompare(right.id)
}

function scaleToSize(placed: ReadonlyMap<string, BrainPoint>, size: LayoutSize): Map<string, BrainPoint> {
  let maxX = 1
  let maxY = 1
  for (const point of placed.values()) {
    maxX = Math.max(maxX, point.x + ORIGIN)
    maxY = Math.max(maxY, point.y + ORIGIN)
  }
  const width = Math.max(size.width, 1)
  const height = Math.max(size.height, 1)
  const scale = Math.min(width / maxX, height / maxY)
  const scaled = new Map<string, BrainPoint>()
  for (const [id, point] of placed) {
    scaled.set(id, { x: point.x * scale, y: point.y * scale })
  }
  return scaled
}

function parseNode(value: unknown): BrainNode {
  if (!isRecord(value) || typeof value.id !== 'string' || !isKind(value.kind)) {
    throw new Error('The brain map could not be read.')
  }
  if (typeof value.label !== 'string' || typeof value.held !== 'boolean') {
    throw new Error('The brain map could not be read.')
  }
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    sentence: optionalText(value.sentence),
    taint: optionalTaint(value.taint),
    session_id: optionalText(value.session_id),
    held: value.held,
    category: typeof value.category === 'string' ? value.category : '',
    confidence_millis: optionalNumber(value.confidence_millis),
    created_at: optionalNumber(value.created_at),
    source_episode: optionalText(value.source_episode),
    status: optionalText(value.status),
    hidden_reason: optionalText(value.hidden_reason),
    subject: optionalText(value.subject),
    entity_kind: optionalText(value.entity_kind),
    tags: stringList(value.tags),
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function parseCatalog(value: unknown): BrainMap['tags'] {
  if (!Array.isArray(value)) return []
  const tags: NonNullable<BrainMap['tags']> = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue
    tags.push({
      id: item.id,
      name: item.name,
      role: typeof item.role === 'string' ? item.role : 'custom',
    })
  }
  return tags
}

function parseEdge(value: unknown): BrainEdge {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    typeof value.from_kind !== 'string' ||
    typeof value.from_id !== 'string' ||
    typeof value.to_kind !== 'string' ||
    typeof value.to_id !== 'string'
  ) {
    throw new Error('The brain map could not be read.')
  }
  return {
    kind: value.kind,
    from_kind: value.from_kind,
    from_id: value.from_id,
    to_kind: value.to_kind,
    to_id: value.to_id,
  }
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  throw new Error('The brain map could not be read.')
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return value
  throw new Error('The brain map could not be read.')
}

function optionalTaint(value: unknown): BrainNode['taint'] {
  if (value === null || value === undefined) return null
  if (value === 'trusted' || value === 'untrusted' || value === 'owner') return value
  throw new Error('The brain map could not be read.')
}

function isKind(value: unknown): value is BrainNodeKind {
  return typeof value === 'string' && KINDS.some((kind) => kind === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
