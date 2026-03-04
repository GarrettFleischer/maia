/**
 * @fileoverview Ask-user tool: agents pose questions with optional choices and an "Other"
 * option; the user submits answers via the UI and the tool returns the original questions
 * and the user's answers.
 * @module lib/tools/ask-user-tool
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import {
  registerPendingQuestion,
  type AskUserQuestionInput,
  type AskUserResult,
} from "../question-service";

const questionSchema = z.object({
  id: z
    .string()
    .describe(
      "Unique id for this question (used as key in the returned answers)",
    ),
  prompt: z.string().describe("Question text shown to the user"),
  choices: z
    .array(z.string())
    .optional()
    .describe("Optional predefined choices; user picks one or enters Other"),
  allowOther: z
    .boolean()
    .optional()
    .describe(
      "If true (default when choices exist), user can enter a custom answer",
    ),
});

const questionsArraySchema = z
  .array(questionSchema)
  .min(1)
  .max(20)
  .describe(
    "List of questions; each can have choices and allowOther for custom input",
  );

/** Schema for the tool definition (array only; no transform) so JSON Schema can be generated. */
const askUserDefinitionSchema = z.object({
  questions: questionsArraySchema,
});

const askUserSchema = z.object({
  questions: z.union([
    questionsArraySchema,
    z.string().transform((s, ctx) => {
      try {
        const parsed: unknown = JSON.parse(s);
        return questionsArraySchema.parse(parsed);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          fatal: true,
          message:
            "questions must be an array of question objects, or a JSON string of that array",
        });
        return [] as z.infer<typeof questionsArraySchema>;
      }
    }),
  ]),
});

export const askUserTool: Tool<z.infer<typeof askUserSchema>, AskUserResult> = {
  name: "ask_user",
  description:
    "Ask the user one or more questions. Each question can have predefined choices and an 'Other' option for custom input. The UI shows a form; when the user submits, returns the original questions and their answers. Use when you need user input to proceed. Example: ask_user({ questions: [{ id: 'env', prompt: 'Which environment?', choices: ['staging', 'production'], allowOther: true }] }).",
  schema: askUserSchema,
  toDefinition: () => ({
    name: "ask_user",
    description:
      "Ask the user one or more questions. Each question can have predefined choices and an 'Other' option for custom input. The UI shows a form; when the user submits, returns the original questions and their answers. Use when you need user input to proceed.",
    parameters: zodToJsonSchema(askUserDefinitionSchema),
  }),
  async execute(args, ctx): Promise<AskUserResult> {
    const questionsInput: AskUserQuestionInput[] = args.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      choices: q.choices,
      allowOther: q.allowOther,
    }));
    const { requestId, promise } = registerPendingQuestion(
      ctx.sessionId,
      questionsInput,
    );

    const payload = questionsInput.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      choices: q.choices,
      allowOther: q.allowOther ?? (q.choices != null && q.choices.length > 0),
    }));

    ctx.events.emit({
      event: "question",
      data: {
        sessionId: ctx.sessionId,
        requestId,
        questions: payload,
      },
    });

    return promise;
  },
};
