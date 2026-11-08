export type CenterView = 'conversation' | 'settings' | 'brain'
export type CenterTarget = 'settings' | 'brain'

export function toggleCenterView(current: CenterView, target: CenterTarget = 'settings'): CenterView {
  return current === target ? 'conversation' : target
}
