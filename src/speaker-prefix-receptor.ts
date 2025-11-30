/**
 * SpeakerPrefixReceptor - Prepends bot name to agent speech content
 *
 * Intercepts veil:operation events for speech facets from agents and
 * modifies the content to prepend the agent's name (e.g., "opus-4-5: Hello!").
 * This allows other bots reading history to identify who said what.
 *
 * The prefix is stripped before sending to Signal (in signal-effector.ts).
 */

import { BaseReceptor } from 'connectome-ts/dist/components/base-martem.js';
import type { SpaceEvent, ReadonlyVEILState, VEILDelta } from 'connectome-ts';

export class SpeakerPrefixReceptor extends BaseReceptor {
  readonly topics = ['veil:operation'];

  transform(event: SpaceEvent, state: ReadonlyVEILState): VEILDelta[] {
    const payload = event.payload as any;

    console.log(`[SpeakerPrefixReceptor] Received veil:operation event`);
    console.log(`[SpeakerPrefixReceptor] Payload keys: ${Object.keys(payload || {}).join(', ')}`);

    // The payload structure is { operation: { type, facet } }
    const op = payload?.operation;
    if (op) {
      console.log(`[SpeakerPrefixReceptor] Operation keys: ${Object.keys(op).join(', ')}`);
      console.log(`[SpeakerPrefixReceptor] Operation type: ${op.type}, facet type: ${op.facet?.type}, agentName: ${op.facet?.agentName}`);
    }

    const operation = op?.type;
    const facet = op?.facet;

    console.log(`[SpeakerPrefixReceptor] Resolved: operation=${operation}, facet id=${facet?.id}`);

    // Only process addFacet operations
    if (operation !== 'addFacet') {
      return [];
    }

    console.log(`[SpeakerPrefixReceptor] addFacet: type=${facet?.type}, agentName=${facet?.agentName}, agentId=${facet?.agentId}`);

    // Only process speech facets from agents
    if (facet?.type !== 'speech' || !facet.agentName || !facet.agentId) {
      return [];
    }

    const agentName = facet.agentName;
    let content = facet.content || '';

    // Strip XML-like tags first (<my_turn>, </my_turn>, etc.)
    const originalContent = content;
    content = content.replace(/<[^>]+>/g, '').trim();
    if (originalContent !== content) {
      console.log(`[SpeakerPrefixReceptor] Stripped tags from content`);
    }

    // Check if content already has this agent's prefix
    if (content.startsWith(`${agentName}: `)) {
      // Still need to update facet.content with stripped version (without tags)
      if (originalContent !== content) {
        facet.content = content;
        console.log(`[SpeakerPrefixReceptor] Updated facet with stripped content (prefix already present)`);
      }
      return [];
    }

    // Modify the facet content in place (before it gets added to VEIL)
    console.log(`[SpeakerPrefixReceptor] Adding prefix "${agentName}:" to facet ${facet.id}`);
    facet.content = `${agentName}: ${content}`;

    // Return empty - we modified the event payload in place
    return [];
  }
}
