#!/usr/bin/env tsx
/**
 * Signal AXON Host - Connectome-native Signal messenger application
 *
 * This is a clean-slate implementation using pure Connectome patterns.
 * Replaces the Node.js implementation with VEIL-based state management.
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import {
  ConnectomeHost,
  Space,
  VEILStateManager,
  ComponentRegistry,
  AnthropicProvider,
  BasicAgent,
  AgentEffector
} from 'connectome-ts';
import { FocusedContextTransform } from './focused-context-transform.js';
import { SpeakerPrefixReceptor } from './speaker-prefix-receptor.js';
import { AnthropicToolProvider } from './anthropic-tool-provider.js';
import { BedrockProvider } from './bedrock-provider.js';
import { migrateImages } from './image-migration.js';
import { ToolLoopAgent, createFetchTool } from './tool-loop-agent.js';
import { ToolAgentEffector, SignalErrorConfig } from './tool-agent-effector.js';
import { ActiveStreamTransform } from 'connectome-ts/dist/transforms/active-stream-transform.js';
import type { ConnectomeApplication } from 'connectome-ts';
import type { AfferentContext } from 'connectome-ts';
import {
  SignalAfferent,
  SignalMessageReceptor,
  SignalReceiptReceptor,
  SignalTypingReceptor,
  SignalSpeechEffector,
  SignalCommandEffector,
  MessageConsistencyReceptor
} from 'signal-axon';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// Note: ToolsComponent is no longer used - tools are now handled natively by ToolLoopAgent

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load configuration
interface BotConfig {
  name: string;
  model: string | null;
  prompt: string | null;
  persist_history?: boolean;
  tools?: string[];
}

interface SignalConfig {
  bots: BotConfig[];
  max_history_messages?: number;
  group_privacy_mode?: string;
  trusted_phone_numbers?: string[];
  session_timeout?: number;
  default_model?: string;
  default_system_instruction?: string;
  random_reply_chance?: number;
  max_bot_mentions_per_conversation?: number;
  max_conversation_frames: number;
  max_memory_frames: number;
}

let CONFIG: SignalConfig;
try {
  const configPath = join(__dirname, '..', 'config.json');
  CONFIG = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err: any) {
  console.error('Error loading config.json:', err.message);
  process.exit(1);
}

class SignalApplication implements ConnectomeApplication {
  // Track afferents by bot name for reconnection support
  private botAfferents = new Map<string, SignalAfferent>();

  async createSpace(hostRegistry?: Map<string, any>, lifecycleId?: string, spaceId?: string): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    // Pass lifecycleId and spaceId for restoration - this preserves element IDs across restarts
    const space = new Space(veilState, hostRegistry, lifecycleId, spaceId);
    return { space, veilState };
  }

  async initialize(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🤖 Initializing Signal bots...\n');

    // Register SignalAfferent component for dynamic creation
    ComponentRegistry.register('SignalAfferent', SignalAfferent);

    // Get phone numbers from environment
    const botPhoneNumbersEnv = process.env.BOT_PHONE_NUMBERS || '';
    const botPhones = botPhoneNumbersEnv.split(',').map(p => p.trim()).filter(p => p);

    if (botPhones.length === 0) {
      throw new Error('No bot phone numbers configured. Please set BOT_PHONE_NUMBERS in .env');
    }

    if (botPhones.length !== CONFIG.bots.length) {
      console.warn(`Warning: Number of phone numbers (${botPhones.length}) doesn't match number of bots (${CONFIG.bots.length})`);
      console.warn(`Using first ${Math.min(botPhones.length, CONFIG.bots.length)} entries`);
    }

    // Build bot UUID and name maps (for mention detection and display)
    const botUuids = new Map<string, string>();
    const botNames = new Map<string, string>();

    // Fetch UUIDs for all bots from Signal CLI accounts.json file
    console.log('Loading bot UUIDs from accounts.json...');
    const accountsPath = '/home/.local/share/signal-api/data/accounts.json';

    try {
      if (fs.existsSync(accountsPath)) {
        const accountsData = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        const accounts = accountsData.accounts || [];

        for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
          const bot = CONFIG.bots[i];
          const botPhone = botPhones[i];
          botNames.set(botPhone, bot.name);

          // Find the account for this bot phone
          const account = accounts.find((acc: any) => acc.number === botPhone);
          if (account?.uuid) {
            botUuids.set(botPhone, account.uuid);
            console.log(`  ${bot.name} (${botPhone}): ${account.uuid}`);
          } else {
            console.warn(`  Warning: No UUID found for ${bot.name} (${botPhone})`);
          }
        }
      } else {
        console.error(`accounts.json not found at ${accountsPath}`);
        console.warn('Continuing without UUIDs - bot message filtering may not work correctly');

        // Still set up names even if file not found
        for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
          const bot = CONFIG.bots[i];
          const botPhone = botPhones[i];
          botNames.set(botPhone, bot.name);
        }
      }
    } catch (error) {
      console.error('Failed to load bot UUIDs:', error);
      console.warn('Continuing without UUIDs - bot message filtering may not work correctly');

      // Still set up names even if error occurs
      for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
        const bot = CONFIG.bots[i];
        const botPhone = botPhones[i];
        botNames.set(botPhone, bot.name);
      }
    }

    // Create and initialize bot afferents directly (no Element tree)
    for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
      const bot = CONFIG.bots[i];
      const botPhone = botPhones[i];

      console.log(`Creating afferent for bot: ${bot.name} (${botPhone})`);

      // Create SignalAfferent directly
      const afferent = new SignalAfferent();

      // Create config for the afferent
      const config = {
        botPhone,
        wsUrl: process.env.WS_BASE_URL || 'ws://localhost:8080',
        httpUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
        maxReconnectTime: 5 * 60 * 1000 // 5 minutes
      };

      const context: AfferentContext<any> = {
        config,
        afferentId: `afferent-${bot.name}`,
        emit: (event) => space.emit(event),
        emitError: (error) => console.error(`[${bot.name}] Error:`, error)
      };

      // Add to space and initialize
      space.addComponent(afferent);
      await afferent.initialize(context);
      await afferent.start();

      // Store in map for later access (reconnection, etc.)
      this.botAfferents.set(bot.name, afferent);

      console.log(`✓ Started afferent for ${bot.name}`);
    }

    // Create agent elements (one per bot) with per-bot LLM providers
    // Using ToolLoopAgent with native tool support for proper tool execution
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Check for AWS credentials for Bedrock models
    const hasAwsCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    if (!hasAwsCredentials) {
      console.warn('⚠ AWS credentials not found - Bedrock models will not be available');
    }

    // Create fetch tool (shared definition for all agents)
    const fetchTool = createFetchTool();

    for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
      const bot = CONFIG.bots[i];
      const botPhone = botPhones[i];

      // Create per-bot LLM provider with the correct model
      const modelName = bot.model || CONFIG.default_model || 'claude-sonnet-4-0';
      const isBedrock = modelName.startsWith('bedrock-');

      let botLlmProvider: AnthropicToolProvider | BedrockProvider;
      if (isBedrock) {
        if (!hasAwsCredentials) {
          console.error(`✗ Skipping ${bot.name}: Bedrock model requires AWS credentials`);
          continue;
        }
        botLlmProvider = new BedrockProvider({
          defaultModel: modelName,
          defaultMaxTokens: 4096
        });
        console.log(`  Using Bedrock provider for ${bot.name} with model: ${modelName}`);
      } else {
        botLlmProvider = new AnthropicToolProvider({
          apiKey,
          defaultModel: modelName,
          defaultMaxTokens: 4096
        });
        console.log(`  Using Anthropic provider for ${bot.name} with model: ${modelName}`);
      }

      // Build tools list based on bot config
      const agentTools = [];
      if (bot.tools?.includes('fetch')) {
        agentTools.push(fetchTool);
      }

      // Create ToolLoopAgent with native tool support
      const agent = new ToolLoopAgent(
        {
          name: bot.name,
          systemPrompt: `You are in a Signal group chat. Your username in this conversation is ${bot.name}. You can mention other participants with @username.`,
          defaultMaxTokens: 4096,
          maxToolRounds: 5,
          tools: agentTools
        },
        botLlmProvider,
        veilState
      );

      // Add ToolAgentEffector instead of AgentEffector
      // Pass Signal config so errors can be sent directly to Signal
      const signalErrorConfig: SignalErrorConfig = {
        apiUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
        botNames
      };
      const effector = new ToolAgentEffector(agent, bot.name, signalErrorConfig);
      space.addComponent(effector);

      console.log(`✓ Created agent: ${bot.name} with ${agentTools.length} tool(s)`);
    }

    // Add shared receptors AFTER agents are created
    const messageReceptor = new SignalMessageReceptor({
      botUuids,
      botNames,
      groupPrivacyMode: (CONFIG.group_privacy_mode || 'opt-in') as 'opt-in' | 'opt-out',
      randomReplyChance: CONFIG.random_reply_chance || 0,
      maxBotMentionsPerConversation: CONFIG.max_bot_mentions_per_conversation || 10,
      maxConversationFrames: CONFIG.max_conversation_frames,
      maxMemoryFrames: CONFIG.max_memory_frames
    });
    space.addComponent(messageReceptor);

    const receiptReceptor = new SignalReceiptReceptor();
    space.addComponent(receiptReceptor);

    const typingReceptor = new SignalTypingReceptor();
    space.addComponent(typingReceptor);

    // Pending messages queue for re-processing after reconnection
    const pendingMessages = new Map<string, any[]>();

    // Add message consistency receptor to detect and reconnect missing bots
    const reconnectBot = (botPhone: string, queuedMessage?: any) => {
      const botName = botNames.get(botPhone);
      if (!botName) {
        console.error(`  ⚠ Cannot reconnect - no bot name found for ${botPhone}`);
        return;
      }

      // Queue the message for re-processing
      if (queuedMessage) {
        if (!pendingMessages.has(botPhone)) {
          pendingMessages.set(botPhone, []);
        }
        pendingMessages.get(botPhone)!.push(queuedMessage);
      }

      const afferent = this.botAfferents.get(botName);
      if (!afferent) {
        console.error(`  ⚠ Cannot reconnect - no afferent found for ${botName}`);
        return;
      }

      console.log(`  ↻ Closing and reconnecting [${botPhone}] (${botName})`);
      afferent.stop().then(() => {
        afferent.start().then(() => {
          // Re-process pending messages after reconnection
          const pending = pendingMessages.get(botPhone);
          if (pending && pending.length > 0) {
            console.log(`  ↻ Re-processing ${pending.length} pending message(s) for [${botPhone}]`);
            for (const msgPayload of pending) {
              // Update the botPhone in the payload to match the reconnected bot
              // Add __reprocessed flag to bypass deduplication in SignalAfferent
              const updatedPayload = { ...msgPayload, botPhone, __reprocessed: true };
              // Re-emit the message event so it gets processed by receptors
              space.emit({
                topic: 'signal:message',
                source: space.getRef(),
                timestamp: msgPayload.timestamp || Date.now(),
                payload: updatedPayload
              });
            }
            pendingMessages.delete(botPhone);
          }
        });
      });
    };

    const consistencyReceptor = new MessageConsistencyReceptor({
      botUuids,
      botNames,
      reconnectBot
    });
    space.addComponent(consistencyReceptor);

    // Add speech effector
    const speechEffector = new SignalSpeechEffector({
      apiUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
      botNames,
      maxMessageLength: 400
    });
    space.addComponent(speechEffector);

    // Add active stream transform (reads streamId from event payload and sets frame.activeStream)
    const activeStreamTransform = new ActiveStreamTransform();
    space.addComponent(activeStreamTransform);

    // Add focused context transform (builds HUD context for agents, filtering by stream)
    // This ensures DM context is separate from group chat context
    const contextTransform = new FocusedContextTransform({
      maxConversationFrames: CONFIG.max_conversation_frames
    });
    space.addComponent(contextTransform);

    // Add command effector for !rr, !bb, !mf, !help commands
    const commandEffector = new SignalCommandEffector(
      {
        apiUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
        botNames
      },
      (updates) => {
        // Update the message receptor config at runtime
        messageReceptor.updateConfig(updates);
        // Update context transform if maxConversationFrames changed
        if (updates.maxConversationFrames !== undefined) {
          contextTransform.setMaxConversationFrames(updates.maxConversationFrames);
        }
        console.log('[SignalHost] Config updated via command:', updates);
      }
    );
    space.addComponent(commandEffector);

    // Add speaker prefix receptor (prepends bot name to agent speech content)
    // This allows other bots to identify who said what in conversation history
    const speakerPrefixReceptor = new SpeakerPrefixReceptor();
    space.addComponent(speakerPrefixReceptor);

    console.log(`\n✅ ${CONFIG.bots.length} Signal bots initialized\n`);
    console.log('Listening for Signal messages...\n');
  }

  getComponentRegistry(): typeof ComponentRegistry {
    ComponentRegistry.register('SignalAfferent', SignalAfferent);
    return ComponentRegistry;
  }

  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Signal bots started!\n');

    // Emit an init event to trigger a frame and process deferred operations
    // This ensures components' onFirstFrame is called and tools are registered in VEIL
    space.emit({
      topic: 'system:init',
      payload: { reason: 'Initialize components and register tools' },
      timestamp: Date.now(),
      source: space.getRef()
    });

    // Give time for frame to process
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log('✓ Initial event emitted for component initialization');
  }

  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️  Signal bots restored from snapshot\n');

    // Add transforms and components (these don't persist)
    const activeStreamTransform = new ActiveStreamTransform();
    space.addComponent(activeStreamTransform);

    const contextTransform = new FocusedContextTransform({
      maxConversationFrames: CONFIG.max_conversation_frames
    });
    space.addComponent(contextTransform);

    const speakerPrefixReceptor = new SpeakerPrefixReceptor();
    space.addComponent(speakerPrefixReceptor);

    console.log('✓ Mounted transforms and receptors');

    // Rebuild bot mappings from environment
    const botPhoneNumbersEnv = process.env.BOT_PHONE_NUMBERS || '';
    const botPhones = botPhoneNumbersEnv.split(',').map(p => p.trim()).filter(p => p);

    const botPhoneMap = new Map<string, string>();
    const botUuids = new Map<string, string>();
    const botNames = new Map<string, string>();

    // Build name mappings first
    for (let i = 0; i < CONFIG.bots.length && i < botPhones.length; i++) {
      botPhoneMap.set(CONFIG.bots[i].name, botPhones[i]);
      botNames.set(botPhones[i], CONFIG.bots[i].name);
    }

    // Load UUIDs from accounts.json (same as initialize)
    const accountsPath = '/home/.local/share/signal-api/data/accounts.json';
    try {
      if (fs.existsSync(accountsPath)) {
        const accountsData = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        const accounts = accountsData.accounts || [];

        for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
          const bot = CONFIG.bots[i];
          const botPhone = botPhones[i];
          const account = accounts.find((acc: any) => acc.number === botPhone);
          if (account?.uuid) {
            botUuids.set(botPhone, account.uuid);
            console.log(`  ${bot.name} (${botPhone}): ${account.uuid}`);
          } else {
            console.warn(`  Warning: No UUID found for ${bot.name} (${botPhone})`);
          }
        }
      } else {
        console.warn(`accounts.json not found at ${accountsPath}`);
      }
    } catch (error) {
      console.error('Failed to load bot UUIDs:', error);
    }

    // Get API key for LLM providers
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    const hasAwsCredentials = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    const fetchTool = createFetchTool();

    // Create afferents and agents for all configured bots
    for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
      const botConfig = CONFIG.bots[i];
      const botName = botConfig.name;
      const botPhone = botPhones[i];

      // Create and initialize afferent
      const afferent = new SignalAfferent();
      const config = {
        botPhone,
        wsUrl: process.env.WS_BASE_URL || 'ws://localhost:8080',
        httpUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
        maxReconnectTime: 5 * 60 * 1000
      };

      const context: AfferentContext<any> = {
        config,
        afferentId: `afferent-${botName}`,
        emit: (event) => space.emit(event),
        emitError: (error) => console.error(`[${botName}] Error:`, error)
      };

      space.addComponent(afferent);
      await afferent.initialize(context);
      await afferent.start();

      // Store in map for later access
      this.botAfferents.set(botName, afferent);

      // Create LLM provider for this bot
      const modelName = botConfig.model || CONFIG.default_model || 'claude-sonnet-4-0';
      const isBedrock = modelName.startsWith('bedrock-');

      let botLlmProvider: AnthropicToolProvider | BedrockProvider;
      if (isBedrock) {
        if (!hasAwsCredentials) {
          console.warn(`[onRestore] Skipping agent for ${botName}: Bedrock requires AWS credentials`);
          continue;
        }
        botLlmProvider = new BedrockProvider({
          defaultModel: modelName,
          defaultMaxTokens: 4096
        });
      } else {
        botLlmProvider = new AnthropicToolProvider({
          apiKey,
          defaultModel: modelName,
          defaultMaxTokens: 4096
        });
      }

      // Build tools list
      const agentTools = [];
      if (botConfig.tools?.includes('fetch')) {
        agentTools.push(fetchTool);
      }

      // Create ToolLoopAgent
      const agent = new ToolLoopAgent(
        {
          name: botName,
          systemPrompt: `You are in a Signal group chat. Your username in this conversation is ${botName}. You can mention other participants with @username.`,
          defaultMaxTokens: 4096,
          maxToolRounds: 5,
          tools: agentTools
        },
        botLlmProvider,
        veilState
      );

      // Create and register effector
      const signalErrorConfig: SignalErrorConfig = {
        apiUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
        botNames
      };
      const effector = new ToolAgentEffector(agent, botName, signalErrorConfig);
      space.addComponent(effector);

      console.log(`✓ Restored ${botName} (${botPhone}) with ${agentTools.length} tool(s)`);
    }

    // Create shared receptors
    const messageReceptor = new SignalMessageReceptor({
      botUuids,
      botNames,
      groupPrivacyMode: (CONFIG.group_privacy_mode || 'opt-in') as 'opt-in' | 'opt-out',
      randomReplyChance: CONFIG.random_reply_chance || 0,
      maxBotMentionsPerConversation: CONFIG.max_bot_mentions_per_conversation || 10,
      maxConversationFrames: CONFIG.max_conversation_frames,
      maxMemoryFrames: CONFIG.max_memory_frames
    });
    space.addComponent(messageReceptor);

    const receiptReceptor = new SignalReceiptReceptor();
    space.addComponent(receiptReceptor);

    const typingReceptor = new SignalTypingReceptor();
    space.addComponent(typingReceptor);

    // Create speech effector
    const speechEffector = new SignalSpeechEffector({
      apiUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
      botNames,
      maxMessageLength: 400
    });
    space.addComponent(speechEffector);

    // Create command effector
    const commandEffector = new SignalCommandEffector(
      {
        apiUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
        botNames
      },
      (updates) => {
        messageReceptor.updateConfig(updates);
        // Update context transform if maxConversationFrames changed
        if (updates.maxConversationFrames !== undefined) {
          contextTransform.setMaxConversationFrames(updates.maxConversationFrames);
        }
        console.log('[SignalHost] Config updated via command:', updates);
      }
    );
    space.addComponent(commandEffector);

    console.log('✓ Restored all receptors and effectors');
  }
}

async function main() {
  console.log('💬 Signal AXON Host - Connectome-native Signal bots');
  console.log('====================================================\n');

  const args = process.argv.slice(2);
  const reset = args.includes('--reset');

  if (reset) {
    console.log('🔄 Reset flag detected - starting fresh\n');
  }

  // Validate required environment variables
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const botPhones = (process.env.BOT_PHONE_NUMBERS || '').split(',').map(p => p.trim()).filter(p => p);
  if (botPhones.length === 0) {
    console.error('Error: BOT_PHONE_NUMBERS not set in .env');
    process.exit(1);
  }

  console.log(`Configured ${botPhones.length} bot(s):`);
  for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
    console.log(`  - ${CONFIG.bots[i].name} (${botPhones[i]})`);
  }
  console.log();

  // Create LLM provider (used by host for any fallback purposes)
  const llmProvider = new AnthropicToolProvider({
    apiKey,
    defaultMaxTokens: 4000
  });

  // Create application
  const app = new SignalApplication();

  // Create host
  const host = new ConnectomeHost({
    providers: {
      'llm.primary': llmProvider
    },
    persistence: {
      enabled: !reset,
      storageDir: './signal-bot-state'
    },
    debug: {
      enabled: true,
      port: 3003
    },
    reset
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n\n👋 Shutting down gracefully...');
    await host.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Run image migration if needed (compresses existing images in facets)
  if (!reset) {
    try {
      await migrateImages('./signal-bot-state');
    } catch (error) {
      console.error('[SignalHost] Image migration failed (non-fatal):', error);
    }
  }

  // Start the host
  try {
    const space = await host.start(app);

    // Trim in-memory frames to save memory (old frames are already persisted in buckets on disk)
    const maxMemoryFrames = CONFIG.max_memory_frames;
    const veilStateManager = space.getVEILStateManager();
    const state = veilStateManager.getState();
    const frameCount = state.frameHistory.length;

    if (frameCount > maxMemoryFrames) {
      console.log(`[SignalHost] Trimming in-memory frames: ${frameCount} -> ${maxMemoryFrames} (old frames preserved on disk)`);
      const trimmedState = {
        ...state,
        facets: new Map(state.facets),
        scopes: new Set(state.scopes),
        streams: new Map(state.streams),
        agents: new Map(state.agents),
        removals: new Map(state.removals),
        currentStateCache: new Map(state.currentStateCache),
        frameHistory: state.frameHistory.slice(-maxMemoryFrames)
      };
      veilStateManager.setState(trimmedState);
      console.log(`[SignalHost] Frame trim complete. Memory freed for ${frameCount - maxMemoryFrames} frames.`);
    }
  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
}

main();
