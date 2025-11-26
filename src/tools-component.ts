/**
 * ToolsComponent - Provides tool actions for Signal bots
 *
 * Following the Connectome pattern:
 * - Tools are registered as element-bound actions via registerAction
 * - ActionEffector routes action facets to handlers
 * - Results are emitted as facets for the agent to see
 */

import { InteractiveComponent } from 'connectome-ts';
import axios from 'axios';

export class ToolsComponent extends InteractiveComponent {
  // Declare available actions (used for discovery)
  static actions = {
    fetch: {
      description: 'Fetch content from a URL. Use this to retrieve web pages, APIs, or any HTTP-accessible content.',
      params: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch content from (must be a valid HTTP/HTTPS URL)'
          }
        },
        required: ['url']
      }
    }
  };

  onMount(): void {
    console.log(`[ToolsComponent] Mounting on element: ${this.element.id}`);

    // Subscribe to frame:start so onFirstFrame gets called
    this.element.subscribe('frame:start');

    // Register fetch action handler (deferred facet creation happens in onFirstFrame)
    this.registerActionWithInstructions(
      'fetch',
      async (params) => await this.handleFetch(params),
      `You have access to a fetch tool. To fetch content from a URL, use: {@${this.element.id}.fetch(url="https://example.com")}`,
      {
        description: 'Fetch content from a URL',
        params: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch' }
          },
          required: ['url']
        }
      }
    );

    console.log(`[ToolsComponent] Registered fetch action as ${this.element.id}.fetch`);
  }

  async onFirstFrame(): Promise<void> {
    console.log(`[ToolsComponent] onFirstFrame - processing deferred operations`);
    // Deferred operations from registerAction are processed automatically by base class
    // But we can also add any initial facets here
    this.processDeferredOperations();
  }

  /**
   * Handle fetch action - downloads URL content and emits result as facet
   */
  private async handleFetch(params?: { url?: string }): Promise<void> {
    const url = params?.url;

    if (!url) {
      this.emitResult('fetch', 'Error: No URL provided');
      return;
    }

    console.log(`[ToolsComponent] Fetching URL: ${url}`);

    try {
      const response = await axios.get(url, {
        timeout: 30000,
        maxRedirects: 5,
        maxBodyLength: 50000,
        validateStatus: (status) => status < 500,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SignalBot/1.0)'
        }
      });

      // Limit response size
      const content = String(response.data).substring(0, 50000);
      const result = `Successfully fetched content from ${url}:\n\n${content}`;

      console.log(`[ToolsComponent] Fetch successful, ${content.length} chars`);
      this.emitResult('fetch', result);
    } catch (error: any) {
      const errorMsg = `Error fetching ${url}: ${error.message}`;
      console.error(`[ToolsComponent] ${errorMsg}`);
      this.emitResult('fetch', errorMsg);
    }
  }

  /**
   * Emit tool result as a facet for the agent to see
   */
  private emitResult(actionName: string, result: string): void {
    const facetId = `tool-result-${this.element.id}-${actionName}-${Date.now()}`;

    this.addFacet({
      id: facetId,
      type: 'event',
      content: result,
      displayName: 'tool-result',
      attributes: {
        source: this.element.id,
        eventType: 'tool-result',
        toolName: `${this.element.id}.${actionName}`,
        actionName
      }
    });

    console.log(`[ToolsComponent] Emitted result facet: ${facetId}`);
  }
}
