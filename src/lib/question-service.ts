/**
 * @fileoverview In-process service for agent "ask user" questions: register a pending
 * question set and resolve it when the user submits answers via the API.
 * @module lib/question-service
 */

/**
 * Single question shown to the user: prompt, optional choices, and whether "Other" is allowed.
 */
export interface AskUserQuestionInput {
  /** Unique id for this question (used as key in answers). */
  id: string;
  /** Question text shown to the user. */
  prompt: string;
  /** Optional predefined choices; if present, user can pick one or use "Other" when allowOther is true. */
  choices?: string[];
  /** If true and choices exist, user can enter a custom answer; if no choices, prompt is free text. */
  allowOther?: boolean;
}

/**
 * Payload sent to the client (and stored with pending) for the question form.
 */
export interface AskUserQuestionPayload extends AskUserQuestionInput {
  choices?: string[];
  allowOther: boolean;
}

/**
 * Result returned to the agent: original questions and the user's answers (keyed by question id).
 */
export interface AskUserResult {
  questions: AskUserQuestionPayload[];
  answers: Record<string, string>;
}

interface PendingEntry {
  resolve: (value: AskUserResult) => void;
  reject: (reason: Error) => void;
  questions: AskUserQuestionPayload[];
}

const pending = new Map<string, PendingEntry>();

/** Default timeout in ms after which a pending question is rejected if user never responds. */
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeQuestions(
  input: AskUserQuestionInput[],
): AskUserQuestionPayload[] {
  return input.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    choices: q.choices,
    allowOther: q.allowOther ?? (q.choices != null && q.choices.length > 0),
  }));
}

/**
 * Register a pending question set for a session. Emit the "question" event yourself (via ctx.events)
 * so the client shows the form. When the user submits, call resolveQuestion(requestId, { answers }).
 * @param sessionId - Current session id (included in emitted event for client filtering).
 * @param questions - Questions to show (id, prompt, optional choices, allowOther).
 * @returns requestId to pass to resolveQuestion and a promise that resolves with { questions, answers }.
 */
export function registerPendingQuestion(
  sessionId: string,
  questions: AskUserQuestionInput[],
): { requestId: string; promise: Promise<AskUserResult> } {
  const requestId = `q-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = normalizeQuestions(questions);

  const promise = new Promise<AskUserResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pending.delete(requestId)) {
        reject(
          new Error(
            "Question response timed out; user did not submit in time.",
          ),
        );
      }
    }, PENDING_TIMEOUT_MS);

    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
      questions: payload,
    });
  });

  return { requestId, promise };
}

/**
 * Resolve a pending question with the user's answers. No-op if requestId is unknown.
 * @param requestId - Id returned from registerPendingQuestion.
 * @param payload - Must include answers: Record<questionId, string>.
 */
export function resolveQuestion(
  requestId: string,
  payload: { answers: Record<string, string> },
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  entry.resolve({
    questions: entry.questions,
    answers: payload.answers,
  });
}
