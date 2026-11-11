export const COMPOSER_MIN_PX = 48
export const COMPOSER_MAX_PX = 144

export function composerFieldPx(scrollHeight: number): number {
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return COMPOSER_MIN_PX
  return Math.min(Math.max(scrollHeight, COMPOSER_MIN_PX), COMPOSER_MAX_PX)
}
