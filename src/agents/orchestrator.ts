/**
 * @fileoverview Central agent orchestrator. Manages check-ins, agent-to-agent
 * communication, user DMs, quiet-time awareness, and pending DM flushing.
 * @module agents/orchestrator
 *
 * @brief The orchestrator replaces ad-hoc agent management. It coordinates
 * Maia's periodic check-ins with agents, facilitates agent-to-agent chat,
 * handles DM delivery (respecting quiet time), and generates Maia's periodic
 * summary to the user.
 */

import type {
  AuditLog,
  Clock,
  CryptoProvider,
  FileSystem,
  InboundMessage,
  Logger,
} from "../core/types.js";
import type { SubAgent } from "./factory.js";
import type { ThreadService } from "../threads/service.js";
import type { QueuePriority } from "../providers/queue.js";
import type { AgentRegistry } from "./registry.js";
import type { ApprovedSnippetsRepository } from "../security/approved-snippets.js";
import { applyRememberedContent } from "../memory/remember-block.js";
import type { HandleMessageResult } from "../agent/runtime.js";

/**
 * @brief Function signature for pushing a WebSocket message to connected clients.
 * @param type - Message type (e.g. "agent_dm", "agent_status_update", "thread_update")
 * @param payload - Message payload object
 */
export type WSPushFn = (type: string, payload: Record<string, unknown>) => void;

/**
 * @brief User active-hours configuration for quiet-time awareness.
 */
export interface ActiveHoursConfig {
  /** Start hour (0-23) of user's active period (default: 8) */
  startHour: number;
  /** End hour (0-23) of user's active period (default: 22) */
  endHour: number;
  /** Timezone offset in minutes from UTC (default: server local) */
  timezoneOffsetMinutes?: number;
}

/**
 * @brief Queue manager interface used by the orchestrator: enqueue returns jobId, waitForJobResult returns result.
 */
export interface OrchestratorQueue {
  enqueue(
    action: string,
    args: Record<string, unknown>,
    priority: QueuePriority,
    submitterAgentId: string
  ): string;
  waitForJobResult(jobId: string): Promise<HandleMessageResult>;
}

/**
 * @brief Dependencies for createOrchestrator.
 */
export interface OrchestratorDeps {
  clock: Clock;
  crypto: CryptoProvider;
  logger: Logger;
  threadService: ThreadService;
  priorityQueue: OrchestratorQueue;
  /** Active sub-agent runtimes, keyed by agent ID */
  activeAgents: Map<string, SubAgent>;
  /** Maia's own runtime for generating summaries */
  maiaRuntime: {
    handleMessage: (msg: InboundMessage) => Promise<{ content: string }>;
  };
  /** Function to push WebSocket messages to connected dashboard clients */
  wsPush: WSPushFn;
  /** How often to check in with agents, in ms (default: 30 * 60 * 1000 = 30 min) */
  checkInIntervalMs?: number;
  /** How often to generate a summary for the user, in ms (default: 60 * 60 * 1000 = 1 hour) */
  summaryIntervalMs?: number;
  /** Active hours for quiet-time awareness */
  activeHours?: ActiveHoursConfig;
  /** Optional: for stopping flagged agents and applying remember to other agent workspace */
  agentRegistry?: AgentRegistry;
  /** Optional: skip check-in for an agent if they sent a DM within this many ms */
  checkInSkipIfDmWithinMs?: number;
  /** Optional: when inline security is flagged, check approved snippets and push approval request */
  approvedSnippetsRepo?: ApprovedSnippetsRepository;
  /** Optional: called when a subagent is flagged (not approved); caller pushes approval_request and stores pending */
  onFlaggedAgentApprovalRequest?: (
    agentId: string,
    agentName: string,
    reason: string,
    snippet: string
  ) => void;
  /** Optional: fs for writing to agent workspace paths (e.g. "both remember" in agent-agent chat) */
  agentWorkspaceFs?: FileSystem;
  auditLog?: AuditLog;
  /** Optional: forward DM content to external channels (e.g. Telegram). Called after thread + wsPush. */
  forwardDmToUser?: (content: string) => Promise<void>;
  /** Optional: called when an agent reports progress (for thinking sidebar). */
  onAgentThought?: (agentId: string, content: string) => void;
}

/**
 * @brief Orchestrator interface.
 */
export interface Orchestrator {
  /** Start all timers (check-ins, summary generation, pending DM flush) */
  start(): void;
  /** Stop all timers */
  stop(): void;
  /**
   * @brief Send a DM from an agent (or Maia) to the user, respecting quiet time.
   * @param senderId - Agent ID or "maia"
   * @param senderName - Display name of the sender
   * @param content - Message content
   * @param threadId - Optional thread ID to associate the DM with
   */
  sendDmToUser(senderId: string, senderName: string, content: string, threadId?: string): Promise<void>;
  /**
   * @brief Facilitate a chat message from one agent to another.
   * @param fromAgentId - Sending agent ID
   * @param toAgentId - Target agent ID
   * @param content - Message content
   * @returns The target agent's response
   */
  agentToAgentChat(fromAgentId: string, toAgentId: string, content: string): Promise<string>;
  /**
   * @brief Check whether it's currently within the user's active hours.
   * @returns True if it's a good time to message the user
   */
  isActiveHours(): boolean;
  /**
   * @brief Flush any pending DMs held during quiet time.
   * Merges all pending DMs into a single summary and sends one agent_dm.
   */
  flushPendingDms(): Promise<void>;
  /**
   * @brief Record a user interaction timestamp (for inferring active hours).
   */
  recordUserActivity(): void;
}

/**
 * @brief Creates the agent orchestrator.
 * @param deps - All required dependencies
 * @returns Orchestrator instance
 *
 * @example
 * const orchestrator = createOrchestrator({ ... });
 * orchestrator.start();
 * // Later:
 * await orchestrator.sendDmToUser("research-bot", "ResearchBot", "Found 3 new papers!");
 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const {
    clock,
    crypto,
    logger,
    threadService,
    priorityQueue,
    activeAgents,
    wsPush,
    checkInIntervalMs = 30 * 60 * 1000,
    summaryIntervalMs = 60 * 60 * 1000,
    activeHours = { startHour: 8, endHour: 22 },
    agentRegistry,
    checkInSkipIfDmWithinMs,
    approvedSnippetsRepo,
    onFlaggedAgentApprovalRequest,
    agentWorkspaceFs,
    auditLog,
    forwardDmToUser,
    onAgentThought,
  } = deps;

  let checkInTimer: ReturnType<typeof setInterval> | null = null;
  let summaryTimer: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Track recent user activity timestamps for active-hours inference */
  let lastUserActivity: Date | null = null;

  /**
   * @brief Checks if the current time is within active hours.
   * @returns True if user is likely active
   */
  function isActiveHoursNow(): boolean {
    const now = clock.now();
    let hour: number;

    if (activeHours.timezoneOffsetMinutes !== undefined) {
      // Adjust to user's timezone
      const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
      const userMs = utcMs + activeHours.timezoneOffsetMinutes * 60 * 1000;
      const userTime = new Date(userMs);
      hour = userTime.getHours();
    } else {
      hour = now.getHours();
    }

    // Also consider: if the user was active in the last 15 minutes, treat as active
    if (lastUserActivity) {
      const msSinceActivity = now.getTime() - lastUserActivity.getTime();
      if (msSinceActivity < 15 * 60 * 1000) return true;
    }

    if (activeHours.startHour <= activeHours.endHour) {
      return hour >= activeHours.startHour && hour < activeHours.endHour;
    }
    // Handles wrapping (e.g. startHour=22, endHour=6 for night owls)
    return hour >= activeHours.startHour || hour < activeHours.endHour;
  }

  /**
   * @brief Performs a check-in with all active agents. Asks each agent for status
   * unless they recently sent a DM (within checkInSkipIfDmWithinMs). Handles
   * inline security flags and progress reports from the check-in response.
   */
  async function doCheckIns(): Promise<void> {
    const entries = [...activeAgents.entries()];
    for (const [agentId, subAgent] of entries) {
      if (!activeAgents.has(agentId)) continue;

      if (checkInSkipIfDmWithinMs != null && checkInSkipIfDmWithinMs > 0) {
        const lastDmAt = await threadService.getLastDmSentAt(agentId);
        if (lastDmAt) {
          const elapsed = Date.now() - new Date(lastDmAt).getTime();
          if (elapsed < checkInSkipIfDmWithinMs) {
            logger.debug("Skipping check-in: agent recently sent DM", {
              agentId,
              lastDmAt,
              withinMs: checkInSkipIfDmWithinMs,
            });
            continue;
          }
        }
      }

      try {
        const thread = await threadService.findOrCreateThread(
          "maia-agent-checkin",
          ["maia", agentId],
          `Check-in: ${subAgent.config.name}`
        );

        const checkinPrompt =
          "How is your current task going? Any updates, progress, or blockers to report? If there is something you want to tell the user or Maia, say it here or use progress_report or message(recipientId: 'user' or 'maia', content: '...') so it can be surfaced.";

        await threadService.addMessage(thread.id, "maia", "maia", checkinPrompt);

        const msg: InboundMessage = {
          id: crypto.randomUUID(),
          channelId: `checkin:${agentId}`,
          senderId: "maia",
          content: checkinPrompt,
          timestamp: clock.timestamp(),
          isGroup: false,
        };
        const jobId = priorityQueue.enqueue("handleAgentCheckin", { message: msg, agentId }, "background", agentId);
        const response = await priorityQueue.waitForJobResult(jobId);

        if (response.securityFlagged) {
          // Flag applies to the conversation partner (who sent the message), not the responder.
          // In check-in, Maia sent the message, so the flagged party is maia.
          const { reason, snippet } = response.securityFlagged;
          const flaggedPartyId = "maia";
          const approved =
            approvedSnippetsRepo && (await approvedSnippetsRepo.isApproved(flaggedPartyId, snippet));
          if (approved) {
            logger.debug("Inline security flag skipped: snippet approved", { flaggedPartyId });
          } else {
            if (auditLog) {
              void auditLog.log("INLINE_SECURITY_FLAG", {
                flaggedPartyId,
                reportedBy: agentId,
                reason,
                snippet: snippet.slice(0, 200),
                timestamp: clock.timestamp(),
              });
            }
            onFlaggedAgentApprovalRequest?.(
              flaggedPartyId,
              "Maia",
              reason,
              snippet
            );
            await orchestrator.sendDmToUser(
              "maia",
              "Maia",
              `Agent **${subAgent.config.name}** (${agentId}) reported a concern about my message: ${reason}. Please review in the dashboard.`
            );
            logger.warn("Agent reported security concern about check-in message", {
              agentId,
              reason,
            });
            // Do not stop the agent; the flag applies to Maia (the sender), not the responder.
          }
        }

        if (response.progressReport) {
          const { status, summary } = response.progressReport;
          onAgentThought?.(agentId, `[${status}] ${summary}`);
          if (status !== "thinking" && status !== "planning") {
            await orchestrator.sendDmToUser(
              agentId,
              subAgent.config.name,
              `Progress: [${status}] ${summary}`
            );
          }
        }

        await threadService.addMessage(thread.id, agentId, "agent", response.content);

        const contentLower = response.content.toLowerCase();
        const seemsIdle =
          /nothing to do|no task|don't have (a )?task|not doing anything|idle|nothing (right )?now|no (current )?work|nothing on my plate/i.test(contentLower) ||
          (contentLower.includes("nothing") && contentLower.includes("do"));

        if (seemsIdle) {
          const followUp =
            "If you'd like something to do, you can use task_manage to schedule a goal or task for yourself. If you prefer, I can suggest a task—just say what would be useful. If your purpose is fully served, you can call agent_shutdown.";
          await threadService.addMessage(thread.id, "maia", "maia", followUp);
          const followUpMsg: InboundMessage = {
            id: crypto.randomUUID(),
            channelId: `checkin:${agentId}`,
            senderId: "maia",
            content: followUp,
            timestamp: clock.timestamp(),
            isGroup: false,
          };
          const followUpJobId = priorityQueue.enqueue("handleAgentCheckin", { message: followUpMsg, agentId }, "background", agentId);
          const followUpResponse = await priorityQueue.waitForJobResult(followUpJobId);
          await threadService.addMessage(thread.id, agentId, "agent", followUpResponse.content);
        }

        wsPush("agent_status_update", {
          agentId,
          agentName: subAgent.config.name,
          status: "active",
          lastCheckin: clock.timestamp(),
          summary: response.content.slice(0, 200),
        });

        logger.debug("Check-in completed", { agentId, responseLength: response.content.length });
      } catch (err) {
        logger.warn("Check-in failed", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * @brief Generates a periodic summary of all agents and sends it to the user as a DM.
   */
  async function doSummary(): Promise<void> {
    if (activeAgents.size === 0) return;

    try {
      // Collect recent check-in data
      const agentSummaries: string[] = [];
      for (const [agentId, subAgent] of activeAgents) {
        const threads = await threadService.listThreads(agentId);
        const checkinThreads = threads.filter((t) => t.type === "maia-agent-checkin");
        let lastStatus = "No recent check-in.";

        if (checkinThreads.length > 0) {
          const messages = await threadService.getMessages(checkinThreads[0].id, 2, 0);
          const agentMsg = messages.find((m) => m.senderId === agentId);
          if (agentMsg) {
            lastStatus = agentMsg.content.slice(0, 300);
          }
        }

        agentSummaries.push(
          `**${subAgent.config.emoji} ${subAgent.config.name}** (${agentId}): ${lastStatus}`
        );
      }

      const summaryContent =
        `Here's what your agents are up to:\n\n${agentSummaries.join("\n\n")}\n\n` +
        `Let me know if you'd like me to adjust any of their tasks or priorities.`;

      // Send as a DM from Maia to the user
      await orchestrator.sendDmToUser("maia", "Maia", summaryContent);
    } catch (err) {
      logger.warn("Summary generation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const orchestrator: Orchestrator = {
    start(): void {
      // Start check-in timer
      if (!checkInTimer) {
        logger.info("Orchestrator: starting check-in timer", { intervalMs: checkInIntervalMs });
        checkInTimer = setInterval(() => {
          doCheckIns().catch((err) => {
            logger.warn("Check-in cycle failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, checkInIntervalMs);
      }

      // Start summary timer
      if (!summaryTimer) {
        logger.info("Orchestrator: starting summary timer", { intervalMs: summaryIntervalMs });
        summaryTimer = setInterval(() => {
          doSummary().catch((err) => {
            logger.warn("Summary cycle failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, summaryIntervalMs);
      }

      // Start pending DM flush timer (every 15 minutes)
      if (!flushTimer) {
        flushTimer = setInterval(() => {
          if (isActiveHoursNow()) {
            orchestrator.flushPendingDms().catch((err) => {
              logger.warn("Pending DM flush failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }, 15 * 60 * 1000);
      }
    },

    stop(): void {
      if (checkInTimer) {
        clearInterval(checkInTimer);
        checkInTimer = null;
      }
      if (summaryTimer) {
        clearInterval(summaryTimer);
        summaryTimer = null;
      }
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      logger.info("Orchestrator stopped");
    },

    async sendDmToUser(
      senderId: string,
      senderName: string,
      content: string,
      threadId?: string
    ): Promise<void> {
      // If not active hours, hold the DM as pending
      if (!isActiveHoursNow()) {
        await threadService.storePendingDm(senderId, content);
        logger.debug("DM held (quiet time)", { senderId });
        return;
      }

      // For Maia, use the user-maia chat thread so the message appears in the dashboard when the user opens Maia.
      // For other agents, use an agent-dm thread and push agent_dm.
      const isMaia = senderId === "maia";
      const dmThreadId =
        threadId ??
        (await (async () => {
          if (isMaia) {
            const thread = await threadService.findOrCreateThread(
              "user-maia",
              ["user", "maia"],
              "Chat"
            );
            return thread.id;
          }
          const thread = await threadService.findOrCreateThread(
            "agent-dm",
            [senderId, "user"],
            `DM from ${senderName}`
          );
          return thread.id;
        })());

      const senderType = isMaia ? "maia" : "agent";

      // Record the message in the thread
      await threadService.addMessage(dmThreadId, senderId, senderType, content);

      // Push so the dashboard shows it: thread_update for Maia (user-maia thread), agent_dm for others
      if (isMaia) {
        wsPush("thread_update", {
          threadId: dmThreadId,
          message: {
            senderId,
            senderType,
            content,
            createdAt: clock.timestamp(),
          },
        });
      } else {
        wsPush("agent_dm", {
          agentId: senderId,
          agentName: senderName,
          threadId: dmThreadId,
          content,
        });
      }

      // Forward to external channels (e.g. Telegram) if configured
      if (forwardDmToUser) {
        await forwardDmToUser(content);
      }

      logger.debug("DM sent to user", { senderId, threadId: dmThreadId });
    },

    async agentToAgentChat(
      fromAgentId: string,
      toAgentId: string,
      content: string
    ): Promise<string> {
      const toAgent = activeAgents.get(toAgentId);
      const isMaia = toAgentId === "maia";
      if (!isMaia && !toAgent) {
        throw new Error(`Agent '${toAgentId}' is not active`);
      }
      const toAgentName = isMaia ? "Maia" : (toAgent?.config.name ?? toAgentId);

      // Find or create the agent-agent thread
      const thread = await threadService.findOrCreateThread(
        "agent-agent",
        [fromAgentId, toAgentId],
        `${fromAgentId} <-> ${toAgentId}`
      );

      // Record the outgoing message
      await threadService.addMessage(thread.id, fromAgentId, "agent", content);

      // Send to the target agent
      const msg: InboundMessage = {
        id: crypto.randomUUID(),
        channelId: `agent-chat:${fromAgentId}`,
        senderId: fromAgentId,
        content,
        timestamp: clock.timestamp(),
        isGroup: false,
      };
      const jobId = priorityQueue.enqueue("handleAgentToAgentChat", { message: msg, toAgentId }, "agent", fromAgentId);
      const response = await priorityQueue.waitForJobResult(jobId);

      if (response.securityFlagged) {
        // Flag applies to the conversation partner (who sent the message), not the responder.
        // toAgent replied and flagged what fromAgentId sent; so the flagged party is fromAgentId.
        const { reason, snippet } = response.securityFlagged;
        const flaggedPartyId = fromAgentId;
        const approved =
          approvedSnippetsRepo && (await approvedSnippetsRepo.isApproved(flaggedPartyId, snippet));
        if (approved) {
          logger.debug("Inline security flag skipped: snippet approved", {
            flaggedPartyId,
          });
        } else {
          if (auditLog) {
            void auditLog.log("INLINE_SECURITY_FLAG", {
              flaggedPartyId,
              reportedBy: toAgentId,
              reason,
              snippet: snippet.slice(0, 200),
              timestamp: clock.timestamp(),
            });
          }
          const flaggedPartyName =
            flaggedPartyId === "maia"
              ? "Maia"
              : activeAgents.get(flaggedPartyId)?.config.name ?? flaggedPartyId;
          if (flaggedPartyId !== "maia") {
            activeAgents.delete(flaggedPartyId);
            if (agentRegistry) {
              await agentRegistry.update(flaggedPartyId, { active: false });
            }
          }
          onFlaggedAgentApprovalRequest?.(
            flaggedPartyId,
            flaggedPartyName,
            reason,
            snippet
          );
          await orchestrator.sendDmToUser(
            "maia",
            "Maia",
            flaggedPartyId === "maia"
              ? `Agent **${toAgentName}** (${toAgentId}) reported a concern about my message: ${reason}. Please review in the dashboard.`
              : `Agent **${toAgentName}** (${toAgentId}) reported a concern about **${flaggedPartyName}** (${flaggedPartyId}). I've stopped ${flaggedPartyName}. Please choose what to do in the dashboard.`
          );
          logger.warn("Agent reported security concern; stopped flagged party", {
            flaggedPartyId,
            reportedBy: toAgentId,
            reason,
          });
        }
      }

      if (response.progressReport) {
        const { status, summary } = response.progressReport;
        onAgentThought?.(toAgentId, `[${status}] ${summary}`);
        if (status !== "thinking" && status !== "planning") {
          await orchestrator.sendDmToUser(
            toAgentId,
            toAgentName,
            `Progress: [${status}] ${summary}`
          );
        }
      }

      if (response.remembered && agentWorkspaceFs && agentRegistry) {
        const fromWorkspacePath = agentRegistry.agentWorkspacePath(fromAgentId);
        if (fromWorkspacePath) {
          try {
            await applyRememberedContent(
              agentWorkspaceFs,
              fromWorkspacePath,
              response.remembered,
              logger
            );
          } catch (err) {
            logger.warn("Failed to apply remembered content to from-agent workspace", {
              fromAgentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Record the response
      await threadService.addMessage(
        thread.id,
        toAgentId,
        isMaia ? "maia" : "agent",
        response.content
      );

      // Push thread update to dashboard
      wsPush("thread_update", {
        threadId: thread.id,
        message: {
          senderId: toAgentId,
          senderType: "agent",
          content: response.content,
          createdAt: clock.timestamp(),
        },
      });

      return response.content;
    },

    isActiveHours(): boolean {
      return isActiveHoursNow();
    },

    async flushPendingDms(): Promise<void> {
      const pending = await threadService.getPendingDms("user");
      if (pending.length === 0) return;

      // Merge all pending DMs into one summary
      const grouped = new Map<string, string[]>();
      for (const dm of pending) {
        const existing = grouped.get(dm.senderId) ?? [];
        existing.push(dm.content);
        grouped.set(dm.senderId, existing);
      }

      const parts: string[] = [];
      for (const [senderId, messages] of grouped) {
        const agentInfo = activeAgents.get(senderId);
        const name = senderId === "maia" ? "Maia" : (agentInfo?.config.name ?? senderId);
        if (messages.length === 1) {
          parts.push(`**${name}**: ${messages[0]}`);
        } else {
          parts.push(`**${name}** (${messages.length} messages):\n${messages.map((m, i) => `  ${i + 1}. ${m.slice(0, 200)}`).join("\n")}`);
        }
      }

      const mergedContent = `You have ${pending.length} message(s) from while you were away:\n\n${parts.join("\n\n")}`;

      // Create a DM thread and send the merged message
      const thread = await threadService.findOrCreateThread(
        "agent-dm",
        ["maia", "user"],
        "Catch-up Summary"
      );

      await threadService.addMessage(thread.id, "maia", "maia", mergedContent);

      wsPush("agent_dm", {
        agentId: "maia",
        agentName: "Maia",
        threadId: thread.id,
        content: mergedContent,
      });

      // Clear all flushed pending DMs
      await threadService.clearPendingDms("user");
      logger.info("Pending DMs flushed", { count: pending.length });
    },

    recordUserActivity(): void {
      lastUserActivity = clock.now();
    },
  };

  return orchestrator;
}
