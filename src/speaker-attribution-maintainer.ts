/**
 * SpeakerAttributionMaintainer - Adds speaker attribution to agent speech facets
 *
 * In multi-agent scenarios, the HUD uses facet.state.speaker to attribute speech.
 * However, BasicAgent only sets facet.agentName (top-level), not state.speaker.
 * This maintainer watches for new speech facets and adds state.speaker from agentName.
 */

import { BaseMaintainer } from 'connectome-ts/dist/components/base-martem.js';
import type { FacetDelta, ReadonlyVEILState, MaintainerResult, Frame } from 'connectome-ts';

export class SpeakerAttributionMaintainer extends BaseMaintainer {
  async process(frame: Frame, changes: FacetDelta[], state: ReadonlyVEILState): Promise<MaintainerResult> {
    const events: any[] = [];
    const deltas: any[] = [];

    console.log(`[SpeakerAttributionMaintainer] Processing ${changes.length} changes`);

    for (const change of changes) {
      // Log speech facets for debugging
      if (change.facet.type === 'speech') {
        const f = change.facet as any;
        console.log(`[SpeakerAttributionMaintainer] Speech facet: type=${change.type}, agentName=${f.agentName}, agentId=${f.agentId}, state.speaker=${f.state?.speaker}`);
      }

      // Only process newly added speech facets from agents
      if (change.type === 'added' &&
          change.facet.type === 'speech' &&
          (change.facet as any).agentName &&
          (change.facet as any).agentId) {

        const facet = change.facet as any;

        // Skip if speaker already set
        if (facet.state?.speaker) continue;

        // Create update delta to add state.speaker
        console.log(`[SpeakerAttributionMaintainer] Adding speaker=${facet.agentName} to facet ${facet.id}`);
        deltas.push({
          type: 'updateFacet',
          id: facet.id,
          changes: {
            state: {
              ...(facet.state || {}),
              speaker: facet.agentName
            }
          }
        });
      }
    }

    console.log(`[SpeakerAttributionMaintainer] Returning ${deltas.length} deltas`);
    return { events, deltas };
  }
}
