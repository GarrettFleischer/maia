import { useState } from 'react'
import type { ChatQuestionAnswer, ChatQuestionSpec } from '@/api/superAgentTypes'

export function ChatQuestionCard({
  questions,
  answers,
  onSubmit,
  disabled = false,
}: {
  questions: readonly ChatQuestionSpec[]
  answers?: readonly ChatQuestionAnswer[]
  onSubmit: (answers: ChatQuestionAnswer[]) => void
  disabled?: boolean
}) {
  const answered = answers !== undefined && answers.length > 0
  const [draft, setDraft] = useState(() => initialDraft(questions, answers))

  const submit = () => {
    if (answered || disabled) return
    onSubmit(
      questions.map((question) => ({
        id: question.id,
        selected: [...(draft[question.id]?.selected ?? [])],
        other: draft[question.id]?.other ?? '',
      })),
    )
  }

  return (
    <div className="maia-chat-questions" data-testid="chat-question-card">
      {questions.map((question) => {
        const state = draft[question.id] ?? { selected: [], other: '' }
        return (
          <fieldset key={question.id} className="maia-chat-question" disabled={answered || disabled}>
            <legend>{question.prompt}</legend>
            <div
              className="maia-chat-question-choices"
              role={question.kind === 'single' ? 'radiogroup' : 'group'}
            >
              {question.choices.map((choice) => {
                const checked = state.selected.includes(choice)
                if (question.kind === 'single') {
                  return (
                    <label key={choice} className="maia-chat-choice">
                      <input
                        type="radio"
                        name={`q-${question.id}`}
                        value={choice}
                        checked={checked}
                        disabled={answered || disabled}
                        onChange={() =>
                          setDraft((current) => ({
                            ...current,
                            [question.id]: {
                              selected: [choice],
                              other: current[question.id]?.other ?? '',
                            },
                          }))
                        }
                      />
                      <span>{choice}</span>
                    </label>
                  )
                }
                return (
                  <label key={choice} className="maia-chat-choice">
                    <input
                      type="checkbox"
                      name={`q-${question.id}`}
                      value={choice}
                      checked={checked}
                      disabled={answered || disabled}
                      onChange={() =>
                        setDraft((current) => {
                          const selected = new Set(current[question.id]?.selected ?? [])
                          if (selected.has(choice)) selected.delete(choice)
                          else selected.add(choice)
                          return {
                            ...current,
                            [question.id]: {
                              selected: question.choices.filter((item) => selected.has(item)),
                              other: current[question.id]?.other ?? '',
                            },
                          }
                        })
                      }
                    />
                    <span>{choice}</span>
                  </label>
                )
              })}
            </div>
            <label className="maia-chat-other">
              <span className="visually-hidden">Other</span>
              <input
                type="text"
                aria-label="Other"
                placeholder="Other"
                value={state.other}
                disabled={answered || disabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [question.id]: {
                      selected: current[question.id]?.selected ?? [],
                      other: event.target.value,
                    },
                  }))
                }
              />
            </label>
          </fieldset>
        )
      })}
      {answered ? (
        <p className="maia-question-status" role="status">
          Answered
        </p>
      ) : (
        <button
          type="button"
          className="maia-icon-btn maia-icon-btn--primary"
          aria-label="Submit answers"
          title="Submit answers"
          disabled={disabled}
          onClick={submit}
        >
          <span className="maia-send-icon" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function initialDraft(
  questions: readonly ChatQuestionSpec[],
  answers: readonly ChatQuestionAnswer[] | undefined,
): Record<string, { selected: string[]; other: string }> {
  const byId = new Map((answers ?? []).map((answer) => [answer.id, answer]))
  const draft: Record<string, { selected: string[]; other: string }> = {}
  for (const question of questions) {
    const answer = byId.get(question.id)
    draft[question.id] = {
      selected: answer ? [...answer.selected] : [],
      other: answer?.other ?? '',
    }
  }
  return draft
}
