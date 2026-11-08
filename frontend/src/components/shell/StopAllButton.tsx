export function StopAllButton({
  className,
  onStop,
}: {
  className?: string
  onStop: () => void
}) {
  return (
    <button
      type="button"
      className={className ?? 'maia-btn maia-quiet'}
      aria-label="Stop all running threads"
      onClick={onStop}
    >
      <span className="maia-stop-icon" aria-hidden="true" />
      Stop all running threads
    </button>
  )
}
