/**
 * ToolAgentEffector - Processes agent activations with native tool support
 *
 * This is a custom effector that replaces AgentEffector for Signal bots,
 * using ToolLoopAgent instead of BasicAgent to support native tool calling.
 */

import axios from 'axios';
import { Component, priorityConstraint, ComponentPriority } from 'connectome-ts';
import type {
  FacetDelta,
  ReadonlyVEILState,
  FacetFilter,
  ExecutionContext
} from 'connectome-ts';
import type {
  Facet,
  StreamRef
} from 'connectome-ts';
import { hasStateAspect } from 'connectome-ts/dist/veil/types.js';
import type { RenderedContext } from 'connectome-ts/dist/hud/types-v2.js';
import { ToolLoopAgent } from './tool-loop-agent.js';

export interface SignalErrorConfig {
  apiUrl: string;
  botNames: Map<string, string>;
}

export class ToolAgentEffector extends Component {
  constraints = [priorityConstraint(ComponentPriority.EFFECTOR)];

  facetFilters: FacetFilter[] = [
    { type: 'agent-activation' },
    { type: 'rendered-context' }
  ];

  private agent: ToolLoopAgent;
  private agentName: string;
  private processingActivations = new Set<string>();
  private signalConfig?: SignalErrorConfig;
  private groupIdCache = new Map<string, string>();
  private nameToPhone = new Map<string, string>();

  constructor(agent: ToolLoopAgent, agentName: string, signalConfig?: SignalErrorConfig) {
    super();
    this.agent = agent;
    this.agentName = agentName;
    this.signalConfig = signalConfig;

    // Build reverse map (name -> phone) for looking up bot phone from agent name
    if (signalConfig) {
      for (const [phone, name] of signalConfig.botNames) {
        this.nameToPhone.set(name, phone);
      }
    }
  }

  execute(context: ExecutionContext): void {
    const { state, frame } = context;
    if (!frame?.deltas) return;

    for (const delta of frame.deltas) {
      if (delta.type !== 'addFacet') continue;

      if (delta.facet.type === 'agent-activation') {
        const activationId = delta.facet.id;
        const activationState = hasStateAspect(delta.facet)
          ? (delta.facet.state as Record<string, any>)
          : {};

        // Skip if already processing
        if (this.processingActivations.has(activationId)) continue;

        // Check if this activation targets this agent
        const targetAgent = activationState.targetAgent as string | undefined;
        if (targetAgent && targetAgent !== this.agentName) {
          continue;
        }

        // Look for corresponding rendered context
        const contextFacet = Array.from(state.facets.values()).find(f =>
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === activationId
        );

        if (!contextFacet || !hasStateAspect(contextFacet)) {
          // No context yet, will process in next frame
          continue;
        }

        // Mark as processing
        this.processingActivations.add(activationId);

        // Get stream info
        const flattenedActivation = {
          ...activationState,
          ...(activationState.metadata || {})
        };
        const streamRef = flattenedActivation.streamRef as StreamRef | undefined;
        const streamId = streamRef?.streamId ?? (flattenedActivation.streamId as string | undefined) ?? 'default';

        // Get the context
        const contextState = contextFacet.state as { context: RenderedContext };
        const renderedContext = contextState.context;

        // Run agent cycle in background (pass state for error handling)
        this.runAgentCycleBackground(renderedContext, streamRef, activationId, streamId, state);
      }
    }
  }

  private runAgentCycleBackground(
    context: RenderedContext,
    streamRef: StreamRef | undefined,
    activationId: string,
    streamId: string,
    state: ReadonlyVEILState
  ): void {
    (async () => {
      try {
        console.log(`[ToolAgentEffector:${this.agentName}] Running agent cycle for activation ${activationId}...`);

        // Run the tool-loop agent cycle
        const result = await this.agent.runCycle(context, streamRef);

        console.log(`[ToolAgentEffector:${this.agentName}] Agent cycle completed with ${result.operations.length} operations`);

        // Emit facets via veil:operation
        for (const operation of result.operations) {
          if (operation.type === 'addFacet') {
            const facet = this.prepareFacet(operation.facet, streamRef);
            console.log(`[ToolAgentEffector:${this.agentName}] Emitting facet: ${facet.type} (${facet.id})`);

            this.emit({
              topic: 'veil:operation',
              payload: {
                operation: {
                  type: 'addFacet',
                  facet
                }
              }
            });
          }
        }

        // Note: We do NOT remove the activation facet - it stays in state to prevent
        // duplicate activations from re-processed messages (consistency checker)

        // Clean up rendered-context facet to save memory (it's no longer needed)
        const contextFacetToDelete = Array.from(state.facets.values()).find(f =>
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === activationId
        );
        if (contextFacetToDelete) {
          this.emit({
            topic: 'veil:operation',
            payload: {
              operation: {
                type: 'deleteFacet',
                facetId: contextFacetToDelete.id
              }
            }
          });
          console.log(`[ToolAgentEffector:${this.agentName}] Deleted rendered-context facet ${contextFacetToDelete.id}`);
        }

        console.log(`[ToolAgentEffector:${this.agentName}] Cycle complete`);

      } catch (error) {
        console.error(`[ToolAgentEffector:${this.agentName}] Agent cycle error:`, error);

        // Send error message directly to Signal (without storing in VEIL)
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.sendErrorToSignal(errorMessage, streamId, state);
      } finally {
        this.processingActivations.delete(activationId);
      }
    })();
  }

  private prepareFacet(facet: Facet, streamRef?: StreamRef): Facet {
    const prepared = { ...facet } as Facet;

    // Ensure agentId and agentName are set
    if (!prepared.agentId) {
      (prepared as any).agentId = this.agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    if (!(prepared as any).agentName) {
      (prepared as any).agentName = this.agentName;
    }

    // Ensure streamId is set
    if (streamRef?.streamId && !prepared.streamId) {
      (prepared as any).streamId = streamRef.streamId;
    }

    return prepared;
  }

  /**
   * Send error message directly to Signal without storing in VEIL
   */
  private async sendErrorToSignal(
    errorMessage: string,
    streamId: string,
    state: ReadonlyVEILState
  ): Promise<void> {
    if (!this.signalConfig) {
      console.warn(`[ToolAgentEffector:${this.agentName}] No Signal config - cannot send error message`);
      return;
    }

    // Look up stream facet to get routing info
    const streamFacet = state.facets.get(streamId);
    if (!streamFacet) {
      console.warn(`[ToolAgentEffector:${this.agentName}] Stream not found for error: ${streamId}`);
      return;
    }

    const conversationKey = streamFacet.attributes?.conversationKey;
    const isGroupChat = streamFacet.attributes?.isGroupChat;

    // Get bot phone from agent name
    let botPhone = this.nameToPhone.get(this.agentName);
    if (!botPhone) {
      // Fallback to stream's botPhone
      botPhone = streamFacet.attributes?.botPhone;
    }

    if (!conversationKey || !botPhone) {
      console.warn(`[ToolAgentEffector:${this.agentName}] Missing routing info for error message`);
      return;
    }

    // For group chats, convert internal group ID to external group ID
    let recipientId = conversationKey;
    if (isGroupChat) {
      const externalGroupId = await this.convertGroupId(conversationKey, botPhone);
      if (externalGroupId) {
        recipientId = externalGroupId;
      }
    }

    // Format error message
    const formattedMessage = `⚠️ Error: ${errorMessage}`;

    // Send via Signal API
    const payload = {
      number: botPhone,
      recipients: [recipientId],
      message: formattedMessage,
      text_mode: 'styled'
    };

    const url = `${this.signalConfig.apiUrl}/v2/send`;

    try {
      await axios.post(url, payload);
      console.log(`[ToolAgentEffector:${this.agentName}] Error message sent to ${recipientId}`);
    } catch (sendError: any) {
      console.error(`[ToolAgentEffector:${this.agentName}] Failed to send error message:`, sendError);
      if (sendError.response?.data) {
        console.error(`[ToolAgentEffector:${this.agentName}] Signal API response:`, JSON.stringify(sendError.response.data));
      }
      console.error(`[ToolAgentEffector:${this.agentName}] Payload was:`, JSON.stringify(payload));
    }
  }

  /**
   * Convert internal group ID to external group ID that the API expects
   */
  private async convertGroupId(internalId: string, botPhone: string): Promise<string | null> {
    const cached = this.groupIdCache.get(internalId);
    if (cached) return cached;

    const url = `${this.signalConfig!.apiUrl}/v1/groups/${botPhone}`;
    try {
      const response = await axios.get(url);
      const groups = response.data;

      for (const group of groups) {
        if (group.internal_id === internalId) {
          this.groupIdCache.set(internalId, group.id);
          return group.id;
        }
      }
      return null;
    } catch (error) {
      console.error(`[ToolAgentEffector:${this.agentName}] Error fetching groups:`, error);
      return null;
    }
  }
}
