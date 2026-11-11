const RELOAD_MS = 1000

export function reloadUntilLoaded(
  load: () => Promise<boolean>,
  cancelled: () => boolean,
): () => void {
  let timer = 0
  const attempt = () => {
    void load()
      .then((loaded) => {
        if (cancelled() || loaded) return
        timer = window.setTimeout(attempt, RELOAD_MS)
      })
      .catch(() => {
        if (cancelled()) return
        timer = window.setTimeout(attempt, RELOAD_MS)
      })
  }
  attempt()
  return () => {
    window.clearTimeout(timer)
  }
}
