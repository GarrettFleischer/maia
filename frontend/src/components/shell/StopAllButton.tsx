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
      className={className ?? 'maia-icon-btn'}
      aria-label="Stop all running threads"
      title="Stop all running threads"
      onClick={onStop}
    >
      <span className="maia-stop-icon" aria-hidden="true" />
    </button>
  )
}
