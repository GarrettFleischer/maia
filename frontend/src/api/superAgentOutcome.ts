import type { MessageAdmissionResult } from '@/api/superAgentTypes'

export const MODEL_PROVIDER_UNAVAILABLE_TEXT = 'The model provider is unavailable.'
export const ROUTE_UNREADABLE_TEXT = 'The router proposal could not be read.'
export const PROCESSING_UNAVAILABLE_TEXT =
  'The message was accepted, but processing could not continue.'
export const PROCESSING_PENDING_TEXT =
  'The message was accepted, but its final outcome is unavailable.'
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
      return PROCESSING_PENDING_TEXT
    case 'unknown_outcome':
      return UNKNOWN_ADMITTED_OUTCOME_TEXT
  }
}
