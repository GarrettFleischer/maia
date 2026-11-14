import type { MessageAdmissionResult } from '@/api/superAgentTypes'

export const MODEL_PROVIDER_UNAVAILABLE_TEXT = 'The model provider is unavailable.'
export const ROUTE_UNREADABLE_TEXT = 'The router proposal could not be read.'
export const PROCESSING_UNAVAILABLE_TEXT =
  'Your message was saved, but that turn could not finish. Send it again, or open Tasks if something still needs you.'
export const PROCESSING_PENDING_TEXT =
  'The message was accepted. A final reply is not in the chat yet; the task may still be running.'
export const UNKNOWN_ADMITTED_OUTCOME_TEXT =
  'The message was accepted, but its outcome is unavailable.'

export function admissionOutcomeText(result: MessageAdmissionResult): string | null {
  switch (result.outcome.kind) {
    case 'routed':
      return null
    case 'routing_failed':
      return result.outcome.reason === 'model_provider_unavailable'
        ? MODEL_PROVIDER_UNAVAILABLE_TEXT
        : ROUTE_UNREADABLE_TEXT
    case 'processing_failed':
      return PROCESSING_UNAVAILABLE_TEXT
    case 'processing_pending':
      return null
    case 'unknown_outcome':
      return UNKNOWN_ADMITTED_OUTCOME_TEXT
  }
}
