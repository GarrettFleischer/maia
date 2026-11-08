import type { ActionMatcher, AllowlistEntryDto, CapabilityKind } from '@/api/types'

export function allowlistLogicalKey(entry: {
  capability: CapabilityKind
  matcher: ActionMatcher
  agent: AllowlistEntryDto['agent']
}): string {
  const agent = entry.agent ?? '*'
  if (entry.matcher.kind === 'command') {
    return [
      entry.capability,
      'command',
      entry.matcher.platform,
      entry.matcher.executable,
      entry.matcher.args.join('\u0000'),
      agent,
    ].join('|')
  }
  return [entry.capability, 'web', entry.matcher.host, entry.matcher.path_prefix, agent].join('|')
}

export function upsertExactAllowlistEntry(
  entries: AllowlistEntryDto[],
  candidate: AllowlistEntryDto,
): AllowlistEntryDto[] {
  const candidateKey = allowlistLogicalKey(candidate)
  const existing = entries.find((entry) => allowlistLogicalKey(entry) === candidateKey)
  const nextEntry = existing
    ? {
        ...existing,
        ...candidate,
        id: existing.id,
      }
    : candidate
  return [...entries.filter((entry) => allowlistLogicalKey(entry) !== candidateKey), nextEntry]
}
