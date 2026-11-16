export type CenterView = 'conversation' | 'settings' | 'brain' | 'tasks'
export type CenterTarget = 'settings' | 'brain' | 'tasks'

export function toggleCenterView(current: CenterView, target: CenterTarget = 'settings'): CenterView {
  return current === target ? 'conversation' : target
}
