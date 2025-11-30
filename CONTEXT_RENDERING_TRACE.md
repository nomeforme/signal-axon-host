# Context Rendering Trace: Frames → Anthropic API

This document traces how VEIL frames are transformed into the formatted context sent to the Anthropic API.

## Overview

```
frameHistory → FocusedContextTransform → FrameTrackingHUD → RenderedContext → ToolLoopAgent → AnthropicToolProvider → API
```

## 1. Agent Activation Trigger

When a message comes in that should activate a bot, a `agent-activation` facet is created with:
- `targetAgent`: bot name
- `streamRef.streamId`: the conversation stream (DM or group)

## 2. FocusedContextTransform.process()

**File:** `signal-axon-host/src/focused-context-transform.ts:38-195`

This transform runs during Phase 2 and:

```
state.facets → find 'agent-activation' facets
           ↓
For each activation without a rendered-context:
           ↓
fullState.frameHistory → FILTER by focusedStreamId (lines 74-101)
           ↓
filteredFrames + currentFrame = allFrames
           ↓
this.hud.render(allFrames, facets, veilStateManager, ..., agentOptions)
           ↓
Returns: RenderedContext { messages: [...], metadata: {...} }
           ↓
Inject systemPrompt into messages[0] (lines 160-174)
           ↓
Create 'rendered-context' facet with context stored in state
```

### Frame Filtering Logic (lines 74-101)

```typescript
const filteredFrames = fullState.frameHistory.filter((frame: any) => {
  // If no focused stream specified, include everything
  if (!focusedStreamId) return true;

  // If frame has a stream, it must match (even for early setup frames)
  if (frame.activeStream?.streamId) {
    return frame.activeStream.streamId === focusedStreamId;
  }

  // Include very early setup frames ONLY if they don't have a stream
  if (frame.sequence <= SETUP_FRAME_LIMIT) {
    return true;
  }

  // Check if frame contains any facets for the focused stream
  if (frame.deltas) {
    for (const delta of frame.deltas) {
      if (delta.type === 'addFacet' && delta.facet?.streamId === focusedStreamId) {
        return true;
      }
    }
  }

  return false;
});
```

## 3. FrameTrackingHUD.render()

**File:** `connectome-ts/src/hud/frame-tracking-hud.ts:104-355`

Calls `renderWithFrameTracking()` which:

```
for each frame in frames:
    ↓
    veilStateManager.getStateAtSequence(frame.sequence) → replay deltas to get state
    ↓
    renderFrameAsChunks(frame, source, replayedState) → RenderedChunk[]
    ↓
    chunks have: { content, tokens, role, facetIds, metadata }
    ↓
chunksToMessages(allChunks) → { messages, frameToMessageIndex }
    ↓
Returns RenderedContext:
{
  messages: [
    { role: 'system', content: '...' },
    { role: 'user', content: '...' },
    { role: 'assistant', content: '<my_turn>...</my_turn>' },
    ...
  ],
  metadata: { totalTokens, renderedFrames, frameToMessageIndex }
}
```

### State Reconstruction

For each frame, `getStateAtSequence()` replays all deltas from sequence 1 (or cached snapshot) to reconstruct the VEIL state as it existed at that frame. This is necessary because facets can be added, modified, or removed over time.

**File:** `connectome-ts/src/veil/veil-state.ts:485-597`

```typescript
getStateAtSequence(targetSequence: number, compressionEngine?: any): VEILStateSnapshot {
  // Check cache first
  if (this.historicalStateCache.has(targetSequence)) {
    return this.historicalStateCache.get(targetSequence)!;
  }

  // Find nearest cached snapshot, or start from empty
  // ...

  // Replay frames
  for (const frame of framesToReplay) {
    for (const delta of frame.deltas) {
      this.applyDeltaToSnapshot(delta, facets, removals);
    }
  }

  // Cache and return
}
```

## 4. ToolAgentEffector.process()

**File:** `signal-axon-host/src/tool-agent-effector.ts`

Waits for both `agent-activation` AND `rendered-context` facets:

```
Find rendered-context facet matching activationId
           ↓
contextFacet.state.context → RenderedContext
           ↓
agent.runCycle(context, streamRef)
```

## 5. ToolLoopAgent.runCycle()

**File:** `signal-axon-host/src/tool-loop-agent.ts:110-180`

```
context.messages → LLMMessage[]
           ↓
Strip trailing assistant messages (for tool compatibility with Bedrock)
           ↓
this.provider.generate(messages, { tools, modelId, ... })
           ↓
If stopReason === 'tool_use':
    Execute tools → collect results
    this.provider.sendToolResults(...) → continue loop
           ↓
Return final content and operations
```

## 6. AnthropicToolProvider.generate()

**File:** `signal-axon-host/src/anthropic-tool-provider.ts:74-231`

```
messages → filter out 'cache' role
           ↓
systemMessage = messages.find(m => m.role === 'system')?.content
conversationMessages = messages.filter(m => m.role !== 'system')
           ↓
Convert to Anthropic format:
  anthropicMessages: Anthropic.MessageParam[] = [
    { role: 'user' | 'assistant', content: string | ContentBlock[] }
  ]
           ↓
Build request:
{
  model: 'claude-sonnet-4-0',
  max_tokens: 4096,
  system: systemMessage,       // ← System prompt here
  messages: anthropicMessages, // ← Conversation here
  tools: [...],                // ← Tool definitions
  stop_sequences: [...]
}
           ↓
this.client.messages.create(request)  // ← ACTUAL API CALL
```

## Rolling Window Implementation

To implement a rolling window for context, the best place is in **FocusedContextTransform** after the stream filtering (line 101):

```typescript
// After stream filtering, apply rolling window
const maxFrames = 50; // or configurable
if (filteredFrames.length > maxFrames) {
  filteredFrames = filteredFrames.slice(-maxFrames);
}
```

### State Reconstruction Consideration

There's a key consideration: `getStateAtSequence()` replays from sequence 1. If you clip early frames, the first frame in your window might not have correct reconstructed state.

However, looking at the HUD render call:

```typescript
const context = this.hud.render(
  allFrames,
  fullState.facets,  // ← Current facets passed here
  veilStateManager,
  ...
);
```

The `fullState.facets` contains the current accumulated state, so:
- Ambient facets (tool instructions, etc.) will still be available
- The rolling window mainly affects conversation history rendering
- Each frame's state reconstruction is used for rendering that frame's content

For a proper rolling window with state preservation, you would need to:
1. Keep a baseline snapshot at the clip point, OR
2. Ensure the first frame in the window includes any necessary state context, OR
3. Rely on current facets for persistent state (which already works)

## Key Files

| File | Purpose |
|------|---------|
| `signal-axon-host/src/focused-context-transform.ts` | Frame filtering and context rendering trigger |
| `signal-axon-host/src/tool-agent-effector.ts` | Connects rendered context to agent |
| `signal-axon-host/src/tool-loop-agent.ts` | Tool execution loop |
| `signal-axon-host/src/anthropic-tool-provider.ts` | Anthropic API client |
| `signal-axon-host/src/bedrock-provider.ts` | Bedrock API client (alternative) |
| `connectome-ts/src/hud/frame-tracking-hud.ts` | Frame rendering to messages |
| `connectome-ts/src/veil/veil-state.ts` | State management and reconstruction |
