/**
 * Anthropic LLM Provider with Native Tool Support
 *
 * Extends the basic Anthropic provider to support native tool calling.
 * When tools are provided, the API will return tool_use blocks that can
 * be executed and fed back in a loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse
} from 'connectome-ts/dist/llm/llm-interface.js';

/**
 * Tool schema for Anthropic's native tool API
 */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Extended options with tools support
 */
export interface ToolLLMOptions extends LLMOptions {
  tools?: ToolSchema[];
}

/**
 * Extended response with tool call information
 */
export interface ToolLLMResponse extends LLMResponse {
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, any>;
  }>;
}

export interface AnthropicToolProviderConfig {
  apiKey: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class AnthropicToolProvider implements LLMProvider {
  private client: Anthropic;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: AnthropicToolProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey
    });
    this.defaultModel = config.defaultModel || 'claude-sonnet-4-0';
    this.defaultMaxTokens = config.defaultMaxTokens || 4096;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  async generate(messages: LLMMessage[], options?: ToolLLMOptions): Promise<ToolLLMResponse> {
    // Filter out cache markers
    const apiMessages = messages.filter(m => m.role !== 'cache');

    // Build stop sequences
    const stopSequences = [...(options?.stopSequences || [])];
    if (options?.formatConfig?.assistant?.suffix) {
      const suffix = options.formatConfig.assistant.suffix.trim();
      if (suffix && !stopSequences.includes(suffix)) {
        stopSequences.push(suffix);
      }
    }

    // Convert to Anthropic format
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    // Build Anthropic messages
    const anthropicMessages: Anthropic.MessageParam[] = await Promise.all(
      conversationMessages.map(async (msg) => {
        const attachments = msg.metadata?.attachments;
        const messageContent = msg.role === 'assistant' ? msg.content.trimEnd() : msg.content;

        let content: Anthropic.MessageParam['content'];

        // Handle image attachments
        if (attachments && Array.isArray(attachments) && attachments.length > 0) {
          const contentBlocks: Anthropic.MessageParam['content'] = [];

          for (const attachment of attachments) {
            const contentType = attachment.contentType || attachment.mimeType || '';
            const isImage = contentType.startsWith('image/') || attachment.type === 'image';

            if (isImage) {
              try {
                const imageUrl = attachment.url || attachment.data;
                if (!imageUrl) continue;

                let imageData: string;
                if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
                  imageData = await this.fetchImageAsBase64(imageUrl);
                } else {
                  imageData = imageUrl;
                }

                const mediaType = this.getAnthropicMediaType(contentType);
                if (mediaType) {
                  contentBlocks.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: imageData
                    }
                  } as Anthropic.ImageBlockParam);
                }
              } catch (error) {
                console.error(`[AnthropicToolProvider] Failed to process image:`, error);
              }
            }
          }

          contentBlocks.push({ type: 'text', text: messageContent } as Anthropic.TextBlockParam);
          content = contentBlocks;
        } else {
          content = messageContent;
        }

        return {
          role: msg.role as 'user' | 'assistant',
          content
        };
      })
    );

    // Build request
    const request: Anthropic.MessageCreateParams = {
      model: options?.modelId || this.defaultModel,
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: anthropicMessages
    };

    if (systemMessage) {
      request.system = systemMessage;
    }

    if (options?.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (stopSequences.length > 0) {
      request.stop_sequences = stopSequences;
    }

    // Add tools if provided
    if (options?.tools && options.tools.length > 0) {
      request.tools = options.tools;
    }

    console.log('[AnthropicToolProvider:generate] Starting request...');
    console.log('[AnthropicToolProvider:generate] Model:', request.model);
    console.log('[AnthropicToolProvider:generate] Message count:', anthropicMessages.length);
    console.log('[AnthropicToolProvider:generate] Tools:', options?.tools?.map(t => t.name).join(', ') || 'none');

    // Retry logic
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[AnthropicToolProvider] Retry attempt ${attempt}/${this.maxRetries}`);
        }

        const response = await this.client.messages.create(request);

        // Extract text content
        const textContent = response.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('');

        // Extract tool use blocks
        const toolCalls = response.content
          .filter((block: any) => block.type === 'tool_use')
          .map((block: any) => ({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, any>
          }));

        console.log('[AnthropicToolProvider:generate] Stop reason:', response.stop_reason);
        console.log('[AnthropicToolProvider:generate] Content length:', textContent.length);
        console.log('[AnthropicToolProvider:generate] Tool calls:', toolCalls.length);

        return {
          content: textContent,
          tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
          modelId: response.model,
          stopReason: response.stop_reason as ToolLLMResponse['stopReason'],
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        };
      } catch (error: any) {
        lastError = error;
        console.error(`[AnthropicToolProvider] Request failed (attempt ${attempt + 1}/${this.maxRetries + 1}):`,
          error.message);

        const shouldRetry = attempt < this.maxRetries && this.isRetryableError(error);
        if (shouldRetry) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          console.log(`[AnthropicToolProvider] Will retry in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        break;
      }
    }

    throw new Error(`Anthropic API error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Send tool results back to the API and get the next response
   */
  async sendToolResults(
    messages: LLMMessage[],
    assistantContent: Anthropic.ContentBlock[],
    toolResults: Array<{ tool_use_id: string; content: string }>,
    options?: ToolLLMOptions
  ): Promise<ToolLLMResponse> {
    // Build the conversation with tool results
    const apiMessages = messages.filter(m => m.role !== 'cache');
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    // Convert base messages
    const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map(msg => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.role === 'assistant' ? msg.content.trimEnd() : msg.content
    }));

    // Add the assistant message with tool use
    anthropicMessages.push({
      role: 'assistant',
      content: assistantContent
    });

    // Add tool results as user message
    anthropicMessages.push({
      role: 'user',
      content: toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.tool_use_id,
        content: tr.content
      }))
    });

    // Build request
    const request: Anthropic.MessageCreateParams = {
      model: options?.modelId || this.defaultModel,
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: anthropicMessages
    };

    if (systemMessage) {
      request.system = systemMessage;
    }

    if (options?.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      request.tools = options.tools;
    }

    console.log('[AnthropicToolProvider:sendToolResults] Sending tool results...');
    console.log('[AnthropicToolProvider:sendToolResults] Tool results count:', toolResults.length);

    const response = await this.client.messages.create(request);

    // Extract content
    const textContent = response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');

    const toolCalls = response.content
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, any>
      }));

    console.log('[AnthropicToolProvider:sendToolResults] Stop reason:', response.stop_reason);
    console.log('[AnthropicToolProvider:sendToolResults] New tool calls:', toolCalls.length);

    return {
      content: textContent,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
      modelId: response.model,
      stopReason: response.stop_reason as ToolLLMResponse['stopReason'],
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    };
  }

  /**
   * Get the raw content blocks from the last response for tool result continuation
   */
  getLastResponseBlocks(): Anthropic.ContentBlock[] | undefined {
    return this._lastResponseBlocks;
  }

  private _lastResponseBlocks?: Anthropic.ContentBlock[];

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return 'anthropic-tools';
  }

  getCapabilities(): {
    supportsPrefill: boolean;
    supportsCaching: boolean;
    maxContextLength?: number;
    supportsTools?: boolean;
  } {
    return {
      supportsPrefill: true,
      supportsCaching: true,
      maxContextLength: 200000,
      supportsTools: true
    };
  }

  private isRetryableError(error: any): boolean {
    if (error instanceof Anthropic.APIError) {
      const retryableStatuses = [429, 500, 502, 503, 504];
      if (error.status && retryableStatuses.includes(error.status)) {
        return true;
      }
    }

    const message = (error.message || '').toLowerCase();
    if (message.includes('connection') ||
        message.includes('timeout') ||
        message.includes('econnreset')) {
      return true;
    }

    return false;
  }

  private async fetchImageAsBase64(url: string): Promise<string> {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    const buffer = await response.buffer();
    return buffer.toString('base64');
  }

  private getAnthropicMediaType(contentType: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    const normalized = contentType.toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'image/jpeg';
    if (normalized.includes('png')) return 'image/png';
    if (normalized.includes('gif')) return 'image/gif';
    if (normalized.includes('webp')) return 'image/webp';
    return null;
  }
}
