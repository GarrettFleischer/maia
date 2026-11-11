import type { InspectorFixtureDto } from '@/api/types'

export const defaultInspectorFixture = (): InspectorFixtureDto => ({
  turn: 148,
  cached_percent: 81,
  cache_slots: [
    { id: 'slot-tools', label: 'tools', section: 'fixed' },
    { id: 'slot-agents', label: 'agents', section: 'fixed' },
    { id: 'slot-persona', label: 'Persona · Scout', section: 'fixed' },
    { id: 'slot-mem', label: 'mem_7f3a · Tailscale', section: 'memory' },
    { id: 'slot-recall', label: 'fact_9ab · Pipe-only Chrome', section: 'recall', taint: 'untrusted' },
  ],
  brain_nodes: [
    { id: 'mem_7f3a', label: 'Tailscale' },
    { id: 'mem_12c0', label: 'Desktop brain' },
  ],
  trace_steps: [
    { id: 'step-1', label: 'Readable reasoning excerpt', match_label: 'full' },
    { id: 'step-2', label: 'shell · pwsh -File build.ps1', match_label: 'rejected' },
  ],
})
