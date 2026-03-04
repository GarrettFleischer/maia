/**
 * @fileoverview Modal that displays agent questions (choices + Other) and submits user answers.
 * @module app/components/QuestionFormModal
 */

"use client";

import { useState, type FormEvent } from "react";

export interface QuestionItem {
  id: string;
  prompt: string;
  choices?: string[];
  allowOther: boolean;
}

export interface QuestionFormModalProps {
  /** Request id from the server (used when submitting answers). */
  requestId: string;
  /** Session id for the current thread. */
  sessionId: string;
  /** Questions to show (id, prompt, optional choices, allowOther). */
  questions: QuestionItem[];
  /** Called after answers are submitted successfully. */
  onSubmitted: () => void;
}

const OTHER_VALUE = "__other__";

export default function QuestionFormModal({
  requestId,
  sessionId,
  questions,
  onSubmitted,
}: QuestionFormModalProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (questionId: string, value: string) => {
    if (value === OTHER_VALUE) {
      setAnswers((prev) => ({
        ...prev,
        [questionId]: `Other: ${otherValues[questionId] ?? ""}`,
      }));
    } else {
      setAnswers((prev) => ({ ...prev, [questionId]: value }));
      setOtherValues((prev) => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    }
  };

  const handleOtherChange = (questionId: string, text: string) => {
    setOtherValues((prev) => ({ ...prev, [questionId]: text }));
    setAnswers((prev) => ({ ...prev, [questionId]: `Other: ${text}` }));
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const filled = questions.every((q) => {
      const v = answers[q.id];
      return typeof v === "string" && v.trim().length > 0;
    });
    if (!filled) {
      setError("Please answer all questions.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/chat/question-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          requestId,
          answers: { ...answers },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? "Failed to submit",
        );
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit answers");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="question-modal-title"
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-700">
          <h2
            id="question-modal-title"
            className="text-lg font-medium text-zinc-100"
          >
            Answer the agent&apos;s questions
          </h2>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="px-5 py-4 space-y-5 overflow-y-auto flex-1">
            {questions.map((q) => (
              <div key={q.id}>
                <label
                  htmlFor={`q-${q.id}`}
                  className="block text-sm font-medium text-zinc-300 mb-2"
                >
                  {q.prompt}
                </label>
                {q.choices && q.choices.length > 0 ? (
                  <div className="space-y-2">
                    {q.choices.map((choice) => (
                      <label
                        key={choice}
                        className="flex items-center gap-2 cursor-pointer"
                      >
                        <input
                          type="radio"
                          name={q.id}
                          value={choice}
                          checked={answers[q.id] === choice}
                          onChange={() => handleChange(q.id, choice)}
                          className="rounded border-zinc-600 bg-zinc-800 text-violet-600 focus:ring-violet-600"
                        />
                        <span className="text-zinc-200">{choice}</span>
                      </label>
                    ))}
                    {q.allowOther && (
                      <div className="pl-6 flex flex-col gap-1">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name={q.id}
                            value={OTHER_VALUE}
                            checked={
                              answers[q.id] != null &&
                              answers[q.id].startsWith("Other:")
                            }
                            onChange={() => handleChange(q.id, OTHER_VALUE)}
                            className="rounded border-zinc-600 bg-zinc-800 text-violet-600 focus:ring-violet-600"
                          />
                          <span className="text-zinc-200">Other</span>
                        </label>
                        {(answers[q.id] == null ||
                          answers[q.id].startsWith("Other:")) && (
                          <input
                            type="text"
                            value={
                              otherValues[q.id] ??
                              answers[q.id]?.replace(/^Other:\s*/, "") ??
                              ""
                            }
                            onChange={(e) =>
                              handleOtherChange(q.id, e.target.value)
                            }
                            placeholder="Your answer…"
                            className="mt-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-violet-600"
                          />
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <input
                    id={`q-${q.id}`}
                    type="text"
                    value={answers[q.id] ?? ""}
                    onChange={(e) => handleChange(q.id, e.target.value)}
                    placeholder="Your answer…"
                    className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-violet-600"
                  />
                )}
              </div>
            ))}
          </div>
          {error && (
            <div className="px-5 py-2 text-sm text-red-400" role="alert">
              {error}
            </div>
          )}
          <div className="px-5 py-4 border-t border-zinc-700 flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 px-4 py-2 text-sm font-medium text-white transition-colors"
            >
              {submitting ? "Submitting…" : "Submit answers"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
