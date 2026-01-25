/**
 * FocusedContextTransform - A ContextTransform that only renders focused stream content
 *
 * This extends the base ContextTransform behavior but filters out frames from
 * non-focused streams entirely, rather than rendering them with unfocused tags.
 *
 * This is necessary for Signal bots where DM and group chat contexts should be
 * completely separate - a DM conversation should not see group chat messages.
 */

import { Component, priorityConstraint } from 'connectome-ts';
import type { ReadonlyVEILState, ExecutionContext } from 'connectome-ts';
import type { VEILDelta, Facet } from 'connectome-ts';
import { FrameTrackingHUD } from 'connectome-ts/dist/hud/frame-tracking-hud.js';
import type { HUDConfig, RenderedContext } from 'connectome-ts/dist/hud/types-v2.js';

// Helper to check if facet has state aspect
function hasStateAspect(facet: Facet): facet is Facet & { state: Record<string, any> } {
  return 'state' in facet && facet.state !== null && typeof facet.state === 'object';
}

export interface FocusedContextTransformConfig {
  defaultOptions?: Partial<HUDConfig>;
  // Maximum frames to process (applied globally before filtering)
  // Bounds processing time regardless of stream count
  // Set via max_conversation_frames in config.json
  maxConversationFrames: number;
}

export class FocusedContextTransform extends Component {
  // Priority: Run after compression (which has priority 10)
  // Keep same priority=100 as before
  constraints = [priorityConstraint(100)];

  // Number of initial setup frames to always include regardless of stream
  private static readonly SETUP_FRAME_LIMIT = 5;

  private hud: FrameTrackingHUD;
  private defaultOptions?: Partial<HUDConfig>;
  private _maxConversationFrames: number;

  constructor(config: FocusedContextTransformConfig) {
    super();
    this.defaultOptions = config.defaultOptions;
    this._maxConversationFrames = config.maxConversationFrames;
    this.hud = new FrameTrackingHUD();
  }

  /** Get current max conversation frames setting */
  get maxConversationFrames(): number {
    return this._maxConversationFrames;
  }

  /** Update max conversation frames at runtime (via !mf command) */
  setMaxConversationFrames(value: number): void {
    this._maxConversationFrames = value;
    console.log(`[FocusedContextTransform] maxConversationFrames updated to ${value}`);
  }

  execute(context: ExecutionContext): void {
    const { state } = context;
    const deltas: VEILDelta[] = [];

    // Cache rendered context by streamId to avoid duplicate rendering
    // when multiple activations exist for the same stream (e.g., mention + random reply)
    const contextCache = new Map<string, RenderedContext>();

    // Find all agent-activation facets that need context rendered
    for (const [id, facet] of state.facets) {
      if (facet.type === 'agent-activation' && hasStateAspect(facet)) {
        const activationState = facet.state as Record<string, any>;

        // Skip if context already rendered for this activation
        const contextExists = Array.from(state.facets.values()).some(f =>
          f.type === 'rendered-context' &&
          hasStateAspect(f) &&
          (f.state as Record<string, any>).activationId === id
        );

        if (contextExists) continue;

        // Get the focused stream from the activation
        const focusedStreamId = activationState.streamRef?.streamId;

        // Check if we already rendered context for this stream in this pass
        const cachedContext = focusedStreamId ? contextCache.get(focusedStreamId) : undefined;

        if (cachedContext) {
          // Reuse cached context - just create a new facet referencing it
          const botName = activationState.targetAgent;
          console.log(`[FocusedContextTransform] Reusing cached context for ${botName} (stream ${focusedStreamId})`);

          const contextFacetId = `context-${id}-${Date.now()}`;
          deltas.push({
            type: 'addFacet',
            facet: {
              id: contextFacetId,
              type: 'rendered-context',
              state: {
                activationId: id,
                tokenCount: cachedContext.metadata.totalTokens,
                context: cachedContext
              }
            }
          });
          continue;
        }

        // Get VEILStateManager from Space
        const space = this.space as any;

        if (!space || !space.getVEILStateManager) {
          console.error('[FocusedContextTransform] Cannot access VEILStateManager');
          continue;
        }

        const veilStateManager = space.getVEILStateManager();
        const fullState = veilStateManager.getState();

        // Get current frame from Space
        const currentFrame = space?.getCurrentFrame();

        // PRE-CLIP: Limit total frames to process for bounded response times
        // This is applied BEFORE filtering to ensure processing time has an upper bound
        const maxFrames = this._maxConversationFrames;
        const frameHistory = fullState.frameHistory.length > maxFrames
          ? fullState.frameHistory.slice(-maxFrames)
          : fullState.frameHistory;

        if (fullState.frameHistory.length > maxFrames) {
          console.log(`[FocusedContextTransform] Pre-clipped ${fullState.frameHistory.length} frames to ${maxFrames} for processing`);
        }

        // FILTER FRAMES: Only include frames that match the focused stream
        // Be strict - exclude frames from other streams entirely
        const filteredFrames = frameHistory.filter((frame: any) => {
          // If no focused stream specified, include everything
          if (!focusedStreamId) return true;

          // If frame has a stream, it must match (even for early setup frames)
          if (frame.activeStream?.streamId) {
            return frame.activeStream.streamId === focusedStreamId;
          }

          // Include very early setup frames ONLY if they don't have a stream
          // (pure initialization frames with no conversation content)
          if (frame.sequence <= FocusedContextTransform.SETUP_FRAME_LIMIT) {
            return true;
          }

          // Check if frame contains any facets for the focused stream
          // This catches agent speech which has streamId on facet but not on frame
          if (frame.deltas) {
            for (const delta of frame.deltas) {
              if (delta.type === 'addFacet' && delta.facet?.streamId === focusedStreamId) {
                return true;
              }
            }
          }

          // Frames without activeStream or matching facets are likely receipts/typing - exclude them
          return false;
        });

        console.log(`[FocusedContextTransform] Filtered ${frameHistory.length} frames to ${filteredFrames.length} for stream ${focusedStreamId}`);

        // Add current frame if it matches
        const allFrames = [...filteredFrames];
        if (currentFrame) {
          const isAlreadyInHistory = filteredFrames.some((f: any) => f.sequence === currentFrame.sequence);
          if (!isAlreadyInHistory) {
            // Only add current frame if it matches focused stream or has no stream
            if (!currentFrame.activeStream?.streamId ||
                !focusedStreamId ||
                currentFrame.activeStream.streamId === focusedStreamId) {
              allFrames.push(currentFrame);
            }
          }
        }

        // Get bot name from targetAgent (set by SignalMessageReceptor)
        const botName = activationState.targetAgent;

        // Build system prompt with bot identity and Signal formatting
        const systemPrompt = botName
          ? `You are in a Signal group chat. Your username in this conversation is ${botName}. Here participant messages are prefixed with "username: ". Before sending a message, always check this against your own username to determine if a given message was sent by you or not. You can mention other participants with @username.

Signal supports these text formatting options:
- *bold* for bold
- _italic_ for italic
- ~monospace~ for monospace
- ~strikethrough~ for strikethrough`
          : activationState.systemPrompt || this.defaultOptions?.systemPrompt;

        // Build agent options
        // NOTE: Don't use formatConfig here - the HUD's renderAgentFrameAsChunks already
        // adds <my_turn> tags around assistant content. Adding formatConfig causes
        // double-wrapping which confuses the model and causes empty responses.
        const agentOptions: HUDConfig = {
          ...this.defaultOptions,
          systemPrompt,
          maxTokens: activationState.maxTokens || this.defaultOptions?.maxTokens || 4000,
          metadata: this.defaultOptions?.metadata,
          renderContext: {
            ...this.defaultOptions?.renderContext,
            focusedStream: focusedStreamId
          }
        };

        // Render context with filtered frames
        const renderedContext = this.hud.render(
          allFrames,
          fullState.facets,
          veilStateManager,
          undefined, // No compression
          agentOptions
        );

        // Inject system prompt by APPENDING to existing system message (not replacing)
        // The Anthropic provider only uses the FIRST system message, so we need to combine
        // our bot identity prompt with any existing tool instructions
        if (agentOptions.systemPrompt) {
          const existingSystemMsg = renderedContext.messages.find((m: any) => m.role === 'system');
          if (existingSystemMsg) {
            // Prepend our prompt to existing system content (tool instructions come after)
            existingSystemMsg.content = `${existingSystemMsg.content}\n\n${agentOptions.systemPrompt}`;
            console.log(`[FocusedContextTransform] Appended system prompt to existing system message for ${botName}`);
          } else {
            // No existing system message, create one
            renderedContext.messages.unshift({
              role: 'system',
              content: agentOptions.systemPrompt
            });
            console.log(`[FocusedContextTransform] Created new system message for ${botName}`);
          }
        }

        // Cache the rendered context for this stream
        if (focusedStreamId) {
          contextCache.set(focusedStreamId, renderedContext);
        }

        // Create rendered-context facet
        const contextFacetId = `context-${id}-${Date.now()}`;

        deltas.push({
          type: 'addFacet',
          facet: {
            id: contextFacetId,
            type: 'rendered-context',
            state: {
              activationId: id,
              tokenCount: renderedContext.metadata.totalTokens,
              context: renderedContext
            }
          }
        });
      }
    }

    // Add all deltas via addOperation
    for (const delta of deltas) {
      this.addOperation(delta);
    }
  }
}
