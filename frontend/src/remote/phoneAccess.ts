export function isTailnetOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.hostname.endsWith('.ts.net')
  } catch {
    return false
  }
}

export interface PhoneDevice {
  node_id: string
  name: string
  paired_at: number
}

export interface DesktopPhoneStatus {
  enabled: boolean
  phase: 'disabled' | 'starting' | 'ready' | 'unavailable'
  url: string | null
  reason: string | null
  code_active: boolean
  devices: PhoneDevice[]
}

export function readDesktopPhoneStatus(value: unknown): DesktopPhoneStatus | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || typeof value.phase !== 'string') {
    return null
  }
  if (value.phase !== 'disabled' && value.phase !== 'starting' && value.phase !== 'ready' && value.phase !== 'unavailable') {
    return null
  }
  if (!Array.isArray(value.devices)) return null
  const devices: PhoneDevice[] = []
  for (const device of value.devices) {
    if (!isRecord(device) || typeof device.node_id !== 'string' || typeof device.name !== 'string') return null
    if (typeof device.paired_at !== 'number') return null
    devices.push({ node_id: device.node_id, name: device.name, paired_at: device.paired_at })
  }
  return {
    enabled: value.enabled,
    phase: value.phase,
    url: typeof value.url === 'string' ? value.url : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    code_active: value.code_active === true,
    devices,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
