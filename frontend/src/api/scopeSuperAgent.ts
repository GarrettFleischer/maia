import type { LiveFrame, SuperAgentBackendScope, SuperAgentClient } from '@/api/superAgentTypes'

/** Binds transcript, sidebar, and send to one bot without changing the hook's call shape. */
export function scopeSuperAgentClient(client: SuperAgentClient, botId: string): SuperAgentClient {
  const id = botId.trim().length > 0 ? botId.trim() : 'maia'
  return {
    ...client,
    botId: id,
    backendScope: `${client.backendScope}:bot:${id}` as SuperAgentBackendScope,
    sidebar: () => client.sidebar(id),
    transcript: () => client.transcript(id),
    send: (operationId, text, attachmentIds) => client.send(operationId, text, attachmentIds, id),
    ...(client.subscribeLive
      ? {
          subscribeLive: (onFrame: (frame: LiveFrame) => void) =>
            client.subscribeLive?.((frame) => {
              if (frame.kind === 'cleared') {
                if (frame.bot_id.length > 0 && frame.bot_id !== id) return
              } else if (frame.reply.bot_id !== id) {
                return
              }
              onFrame(frame)
            }) ?? (() => undefined),
        }
      : {}),
  }
}
