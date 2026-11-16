import { useState } from 'react'

export function ChatSecretField({
  name,
  provided = false,
  onSubmit,
  disabled = false,
}: {
  name: string
  provided?: boolean
  onSubmit: (value: string) => void
  disabled?: boolean
}) {
  const [value, setValue] = useState('')
  const [revealed, setRevealed] = useState(false)

  if (provided) {
    return (
      <div className="maia-chat-secret maia-chat-secret--provided" data-testid="chat-secret-field">
        <p className="maia-chat-secret-name">{name}</p>
        <p className="maia-chat-widget-status" role="status">
          Provided
        </p>
      </div>
    )
  }

  return (
    <div className="maia-chat-secret" data-testid="chat-secret-field">
      <label className="maia-chat-secret-field">
        <span className="maia-chat-secret-name">{name}</span>
        <input
          type={revealed ? 'text' : 'password'}
          aria-label={name}
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="maia-icon-btn"
        aria-label={revealed ? 'Hide secret' : 'Reveal secret'}
        title={revealed ? 'Hide secret' : 'Reveal secret'}
        disabled={disabled}
        onClick={() => setRevealed((current) => !current)}
      >
        <span
          className={revealed ? 'maia-reveal-icon maia-reveal-icon--on' : 'maia-reveal-icon'}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        className="maia-icon-btn maia-icon-btn--primary"
        aria-label="Submit secret"
        title="Submit secret"
        disabled={disabled || value.trim().length === 0}
        onClick={() => {
          if (disabled || value.trim().length === 0) return
          onSubmit(value)
        }}
      >
        <span className="maia-send-icon" aria-hidden="true" />
      </button>
    </div>
  )
}
