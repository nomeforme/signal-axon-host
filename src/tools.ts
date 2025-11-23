/**
 * Tool definitions for Signal bots using Connectome's native ToolDefinition interface
 */

import type { ToolDefinition } from 'connectome-ts';
import axios from 'axios';

/**
 * Fetch content from a URL
 */
async function fetchUrl(url: string): Promise<string> {
  if (!url) {
    return 'Error: No URL provided';
  }

  try {
    const response = await axios.get(url, {
      timeout: 30000,
      maxRedirects: 5,
      maxBodyLength: 50000, // ~50KB limit
      validateStatus: (status) => status < 500 // Accept redirects and client errors
    });

    // Limit response size to avoid overwhelming context
    const content = response.data.toString().substring(0, 50000);
    return `Successfully fetched content from ${url}:\n\n${content}`;
  } catch (error: any) {
    return `Error fetching ${url}: ${error.message}`;
  }
}

/**
 * Fetch tool definition
 */
export const fetchTool: ToolDefinition = {
  name: 'fetch',
  description: 'Fetch content from a URL. Use this to retrieve web pages, APIs, or any HTTP-accessible content.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from (must be a valid HTTP/HTTPS URL)'
      }
    },
    required: ['url']
  },
  handler: async (params: any) => {
    return await fetchUrl(params.url);
  }
};

/**
 * Get tools based on tool name array from config
 */
export function getToolsForBot(toolNames: string[]): ToolDefinition[] {
  const availableTools: Record<string, ToolDefinition> = {
    fetch: fetchTool
  };

  return toolNames
    .filter(name => availableTools[name])
    .map(name => availableTools[name]);
}
