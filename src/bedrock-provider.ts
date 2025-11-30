/**
 * AWS Bedrock LLM Provider
 *
 * Implements the LLMProvider interface for AWS Bedrock's Claude models.
 */

import AWS from 'aws-sdk';
import type {
  LLMProvider,
  LLMMessage,
  LLMOptions,
  LLMResponse
} from 'connectome-ts/dist/llm/llm-interface.js';

export interface BedrockProviderConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export class BedrockProvider implements LLMProvider {
  private client: AWS.BedrockRuntime;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(config: BedrockProviderConfig) {
    this.client = new AWS.BedrockRuntime({
      region: config.region || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: config.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
    });
    this.defaultModel = config.defaultModel || 'claude-3-5-sonnet-20241022';
    this.defaultMaxTokens = config.defaultMaxTokens || 4096;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  /**
   * Convert model name to Bedrock model ID
   * e.g., claude-3-5-sonnet-20241022 -> us.anthropic.claude-3-5-sonnet-20241022-v2:0
   */
  private getBedrockModelId(modelName: string): string {
    // Remove 'bedrock-' prefix if present
    const baseModel = modelName.replace(/^bedrock-/, '');

    // Special case for claude-3-5-sonnet-20241022 (uses v2 and us. prefix)
    if (baseModel.includes('claude-3-5-sonnet-20241022')) {
      return `us.anthropic.${baseModel}-v2:0`;
    }

    // Standard format for other models
    return `anthropic.${baseModel}-v1:0`;
  }

  async generate(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    // Filter out cache markers and system messages
    const apiMessages = messages.filter(m => m.role !== 'cache');

    // Extract system message
    const systemMessage = apiMessages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = apiMessages.filter(m => m.role !== 'system');

    // Build stop sequences
    const stopSequences = [...(options?.stopSequences || [])];
    if (options?.formatConfig?.assistant?.suffix) {
      const suffix = options.formatConfig.assistant.suffix.trim();
      if (suffix && !stopSequences.includes(suffix)) {
        stopSequences.push(suffix);
      }
    }

    // Convert to Bedrock format and merge consecutive user messages
    const bedrockMessages = this.mergeConsecutiveMessages(
      conversationMessages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: this.formatContent(msg)
      }))
    );

    const modelId = options?.modelId || this.defaultModel;
    const bedrockModelId = this.getBedrockModelId(modelId);

    const bedrockBody: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options?.maxTokens || this.defaultMaxTokens,
      messages: bedrockMessages
    };

    if (systemMessage) {
      bedrockBody.system = systemMessage;
    }

    if (stopSequences.length > 0) {
      bedrockBody.stop_sequences = stopSequences;
    }

    if (options?.temperature !== undefined) {
      bedrockBody.temperature = options.temperature;
    }

    console.log('[BedrockProvider:generate] Starting request...');
    console.log('[BedrockProvider:generate] Model ID:', bedrockModelId);
    console.log('[BedrockProvider:generate] Message count:', bedrockMessages.length);

    // Retry logic
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[BedrockProvider] Retry attempt ${attempt}/${this.maxRetries}`);
        }

        const params = {
          modelId: bedrockModelId,
          body: JSON.stringify(bedrockBody),
          contentType: 'application/json',
          accept: 'application/json'
        };

        const response = await this.client.invokeModel(params).promise();
        const responseBody = JSON.parse(response.body?.toString() || '{}');

        // Extract text content
        const content = responseBody.content
          ?.filter((block: any) => block.type === 'text')
          ?.map((block: any) => block.text)
          ?.join('') || '';

        console.log('[BedrockProvider:generate] Response length:', content.length);
        console.log('[BedrockProvider:generate] Stop reason:', responseBody.stop_reason);

        return {
          content,
          tokensUsed: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0),
          modelId: bedrockModelId
        };
      } catch (error: any) {
        lastError = error;
        console.error(`[BedrockProvider] Request failed (attempt ${attempt + 1}/${this.maxRetries + 1}):`,
          error.message);

        const shouldRetry = attempt < this.maxRetries && this.isRetryableError(error);

        if (shouldRetry) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          console.log(`[BedrockProvider] Will retry in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        break;
      }
    }

    throw new Error(`Bedrock API error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Format message content for Bedrock API
   */
  private formatContent(msg: LLMMessage): Array<{ type: string; text?: string; source?: any }> {
    // For assistant messages, trim trailing whitespace
    const content = msg.role === 'assistant' ? msg.content.trimEnd() : msg.content;

    const contentBlocks: Array<{ type: string; text?: string; source?: any }> = [];

    // Handle attachments if present
    const attachments = msg.metadata?.attachments;
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const attachment of attachments) {
        const contentType = attachment.contentType || attachment.mimeType || '';
        const isImage = contentType.startsWith('image/');

        if (isImage && attachment.data) {
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: this.getMediaType(contentType),
              data: attachment.data
            }
          });
        }
      }
    }

    // Add text content
    if (content) {
      contentBlocks.push({ type: 'text', text: content });
    }

    return contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }];
  }

  /**
   * Merge consecutive user messages (Bedrock requirement)
   */
  private mergeConsecutiveMessages(
    messages: Array<{ role: 'user' | 'assistant'; content: any }>
  ): Array<{ role: 'user' | 'assistant'; content: any }> {
    if (!messages || messages.length === 0) return messages;

    const merged: Array<{ role: 'user' | 'assistant'; content: any }> = [];
    let i = 0;

    while (i < messages.length) {
      const current = messages[i];

      if (current.role === 'user') {
        const userContents: any[] = [];

        while (i < messages.length && messages[i].role === 'user') {
          const content = messages[i].content;
          if (Array.isArray(content)) {
            userContents.push(...content);
          } else if (typeof content === 'string') {
            userContents.push({ type: 'text', text: content });
          }
          i++;
        }

        merged.push({ role: 'user', content: userContents });
      } else {
        // Check for consecutive assistant messages
        if (merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
          // Insert separator user message
          merged.push({ role: 'user', content: [{ type: 'text', text: '[continue]' }] });
        }
        merged.push(current);
        i++;
      }
    }

    return merged;
  }

  private getMediaType(contentType: string): string {
    const normalized = contentType.toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'image/jpeg';
    if (normalized.includes('png')) return 'image/png';
    if (normalized.includes('gif')) return 'image/gif';
    if (normalized.includes('webp')) return 'image/webp';
    return 'image/jpeg';
  }

  private isRetryableError(error: any): boolean {
    if (error.statusCode) {
      const retryableStatuses = [429, 500, 502, 503, 504];
      if (retryableStatuses.includes(error.statusCode)) {
        return true;
      }
    }

    const message = (error.message || '').toLowerCase();
    if (message.includes('throttl') ||
        message.includes('timeout') ||
        message.includes('connection')) {
      return true;
    }

    return false;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getProviderName(): string {
    return 'bedrock';
  }

  getCapabilities(): {
    supportsPrefill: boolean;
    supportsCaching: boolean;
    maxContextLength?: number;
  } {
    return {
      supportsPrefill: true,
      supportsCaching: false,
      maxContextLength: 200000
    };
  }
}
