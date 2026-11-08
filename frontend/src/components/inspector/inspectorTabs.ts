export const INSPECTOR_TABS = ['cache', 'brain', 'trace'] as const

export type InspectorTabId = (typeof INSPECTOR_TABS)[number]
export type InspectorNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export function nextInspectorTab(
  current: InspectorTabId,
  key: InspectorNavigationKey,
): InspectorTabId {
  if (key === 'Home') return INSPECTOR_TABS[0]
  if (key === 'End') return INSPECTOR_TABS[INSPECTOR_TABS.length - 1]
  const currentIndex = INSPECTOR_TABS.indexOf(current)
  const step = key === 'ArrowRight' ? 1 : -1
  const nextIndex = (currentIndex + step + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
  return INSPECTOR_TABS[nextIndex] ?? current
}
