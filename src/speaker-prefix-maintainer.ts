/**
 * SpeakerPrefixMaintainer - Prepends bot name to agent speech content
 *
 * When an agent creates a speech facet, this maintainer prepends the agent's name
 * to the content (e.g., "opus-4-5: Hello!"). This allows other bots reading history
 * to identify who said what.
 *
 * The prefix is stripped before sending to Signal (in signal-effector.ts).
 */

import { BaseMaintainer } from 'connectome-ts/dist/components/base-martem.js';
import type { FacetDelta, ReadonlyVEILState, MaintainerResult, Frame } from 'connectome-ts';

export class SpeakerPrefixMaintainer extends BaseMaintainer {
  async process(frame: Frame, changes: FacetDelta[], state: ReadonlyVEILState): Promise<MaintainerResult> {
    const events: any[] = [];
    const deltas: any[] = [];

    console.log(`[SpeakerPrefixMaintainer] Processing ${changes.length} changes`);

    for (const change of changes) {
      if (change.facet.type === 'speech' && (change.facet as any).agentName) {
        console.log(`[SpeakerPrefixMaintainer] Found agent speech: ${change.facet.id}, agentName=${(change.facet as any).agentName}`);
      }
      // Only process newly added speech facets from agents
      if (change.type === 'added' &&
          change.facet.type === 'speech' &&
          (change.facet as any).agentName &&
          (change.facet as any).agentId) {

        const facet = change.facet as any;
        const agentName = facet.agentName;
        const content = facet.content || '';

        // Skip if content already has this agent's prefix
        if (content.startsWith(`${agentName}: `)) continue;

        // Update facet content to prepend agent name
        console.log(`[SpeakerPrefixMaintainer] Adding prefix "${agentName}:" to facet ${facet.id}`);
        deltas.push({
          type: 'updateFacet',
          id: facet.id,
          changes: {
            content: `${agentName}: ${content}`
          }
        });
      }
    }

    console.log(`[SpeakerPrefixMaintainer] Returning ${deltas.length} deltas`);
    return { events, deltas };
  }
}
