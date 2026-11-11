export function keyboardInsetPx(layoutHeight: number, visualHeight: number, offsetTop: number): number {
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(visualHeight)) return 0
  const offset = Number.isFinite(offsetTop) ? offsetTop : 0
  return Math.max(0, Math.round(layoutHeight - visualHeight - offset))
}
