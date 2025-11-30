/**
 * ToolAgentEffector - Processes agent activations with native tool support
 *
 * This is a custom effector that replaces AgentEffector for Signal bots,
 * using ToolLoopAgent instead of BasicAgent to support native tool calling.
 */

import { BaseEffector } from 'connectome-ts/dist/components/base-martem.js';
import type {
  FacetDelta,
  ReadonlyVEILState,
  EffectorResult,
  FacetFilter,
  ExternalAction
} from 'connectome-ts/dist/spaces/receptor-effector-types.js';
import type {
  Facet,
  StreamRef
} from 'connectome-ts/dist/veil/types.js';
import { hasStateAspect } from 'connectome-ts/dist/veil/types.js';
import type { SpaceEvent } from 'connectome-ts/dist/spaces/types.js';
import type { RenderedContext } from 'connectome-ts/dist/hud/types-v2.js';
import { ToolLoopAgent } from './tool-loop-agent.js';

export class ToolAgentEffector extends BaseEffector {
  facetFilters: FacetFilter[] = [
    { type: 'agent-activation' },
    { type: 'rendered-context' }
  ];

  private agent: ToolLoopAgent;
  private agentName: string;
  private processingActivations = new Set<string>();

  constructor(agent: ToolLoopAgent, agentName: string) {
    super();
    this.agent = agent;
    this.agentName = agentName;
  }

  async process(changes: FacetDelta[], state: ReadonlyVEILState): Promise<EffectorResult> {
    const events: SpaceEvent[] = [];
    const externalActions: ExternalAction[] = [];

    for (const change of changes) {
      if (change.type !== 'added') continue;

      if (change.facet.type === 'agent-activation') {
        const activationId = change.facet.id;
        const activationState = hasStateAspect(change.facet)
          ? (change.facet.state as Record<string, any>)
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
        const context = contextState.context;

        // Run agent cycle in background
        this.runAgentCycleBackground(context, streamRef, activationId, streamId);
      }
    }

    return { events, externalActions };
  }

  private runAgentCycleBackground(
    context: RenderedContext,
    streamRef: StreamRef | undefined,
    activationId: string,
    streamId: string
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

            this.element.emit({
              topic: 'veil:operation',
              source: this.element.getRef(),
              timestamp: Date.now(),
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
        console.log(`[ToolAgentEffector:${this.agentName}] Cycle complete`);

      } catch (error) {
        console.error(`[ToolAgentEffector:${this.agentName}] Agent cycle error:`, error);

        // Emit error event
        this.element.emit({
          topic: 'veil:operation',
          source: this.element.getRef(),
          timestamp: Date.now(),
          payload: {
            operation: {
              type: 'addFacet',
              facet: {
                id: `agent-error-${Date.now()}`,
                type: 'event',
                content: String(error),
                streamId
              }
            }
          }
        });
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
}
