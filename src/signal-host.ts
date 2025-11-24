#!/usr/bin/env tsx
/**
 * Signal AXON Host - Connectome-native Signal messenger application
 *
 * This is a clean-slate implementation using pure Connectome patterns.
 * Replaces the Node.js implementation with VEIL-based state management.
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import axios from 'axios';
import {
  ConnectomeHost,
  Space,
  Element,
  VEILStateManager,
  ComponentRegistry,
  AnthropicProvider,
  BasicAgent,
  AgentEffector,
  ContextTransform,
  ElementRequestReceptor,
  ElementTreeMaintainer
} from 'connectome-ts';
import { ActiveStreamTransform } from 'connectome-ts/dist/transforms/active-stream-transform.js';
import type { ConnectomeApplication } from 'connectome-ts';
import type { AfferentContext } from 'connectome-ts';
import {
  SignalAfferent,
  SignalMessageReceptor,
  SignalReceiptReceptor,
  SignalTypingReceptor,
  SignalSpeechEffector
} from 'signal-axon';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getToolsForBot } from './tools.js';

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
  async createSpace(hostRegistry?: Map<string, any>): Promise<{ space: Space; veilState: VEILStateManager }> {
    const veilState = new VEILStateManager();
    const space = new Space(veilState, hostRegistry);
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

    // Fetch UUIDs for all bots from Signal API
    console.log('Fetching bot UUIDs from Signal API...');
    try {
      const response = await axios.get(`${SIGNAL_API_URL}/v1/accounts`);
      const accounts = response.data;

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
    } catch (error) {
      console.error('Failed to fetch bot UUIDs:', error);
      console.warn('Continuing without UUIDs - bot message filtering may not work correctly');

      // Still set up names even if UUID fetch fails
      for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
        const bot = CONFIG.bots[i];
        const botPhone = botPhones[i];
        botNames.set(botPhone, bot.name);
      }
    }

    // Create bot elements via VEIL (Connectome-native pattern)
    for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
      const bot = CONFIG.bots[i];
      const botPhone = botPhones[i];

      console.log(`Creating bot element: ${bot.name} (${botPhone})`);

      // Create bot element with SignalAfferent component
      space.emit({
        topic: 'element:create',
        source: space.getRef(),
        timestamp: Date.now(),
        payload: {
          parentId: space.id,
          name: `bot-${bot.name}`,
          components: [{
            type: 'SignalAfferent',
            config: {
              botPhone,
              wsUrl: process.env.WS_BASE_URL || 'ws://localhost:8080',
              maxReconnectTime: 5 * 60 * 1000 // 5 minutes
            }
          }]
        }
      });
    }

    // Wait for element creation
    await new Promise(resolve => setTimeout(resolve, 100));

    // Initialize and start all afferents
    for (let i = 0; i < CONFIG.bots.length; i++) {
      const bot = CONFIG.bots[i];
      const botPhone = botPhones[i];
      const botElem = space.children.find(child => child.name === `bot-${bot.name}`);

      if (!botElem) {
        console.warn(`Bot element not found for ${bot.name}`);
        continue;
      }

      const afferent = botElem.components[0] as SignalAfferent;

      // Create proper config for the afferent
      const config = {
        botPhone,
        wsUrl: process.env.WS_BASE_URL || 'ws://localhost:8080',
        maxReconnectTime: 5 * 60 * 1000 // 5 minutes
      };

      const context: AfferentContext<any> = {
        config,
        afferentId: botElem.id,
        emit: (event) => space.emit(event),
        emitError: (error) => console.error(`[${botElem.name}] Error:`, error)
      };

      await afferent.initialize(context);
      await afferent.start();

      console.log(`✓ Started afferent for ${botElem.name}`);
    }

    // Create agent elements (one per bot)
    const llmProvider = (space as any).getReference?.('provider:llm.primary');
    if (!llmProvider) {
      throw new Error('No LLM provider found in space references!');
    }

    for (let i = 0; i < Math.min(botPhones.length, CONFIG.bots.length); i++) {
      const bot = CONFIG.bots[i];
      const botPhone = botPhones[i];

      // Create agent element using Element constructor and addChild
      const agentElem = new Element(`agent-${bot.name}`);
      space.addChild(agentElem);

      // Get tools for this bot
      const tools = getToolsForBot(bot.tools || []);

      // Create agent with bot-specific config
      const agent = new BasicAgent({
        config: {
          name: bot.name,
          systemPrompt: 'You are a helpful AI assistant communicating via Signal messenger.',
          tools: tools
        },
        provider: llmProvider,
        veilStateManager: veilState
      });

      // Add agent effector
      // AgentEffector has no constructor params in current implementation
      // But the example uses (element, agent) pattern - use Object.assign workaround
      const effector = Object.assign(new AgentEffector(), {
        agentElementId: agentElem.id,
        agent: agent
      });
      (effector as any).element = space;
      space.addEffector(effector);

      console.log(`✓ Created agent: ${bot.name}`);
    }

    // Add shared receptors AFTER agents are created
    const messageReceptor = new SignalMessageReceptor({
      botUuids,
      botNames,
      groupPrivacyMode: (CONFIG.group_privacy_mode || 'opt-in') as 'opt-in' | 'opt-out',
      randomReplyChance: CONFIG.random_reply_chance || 0,
      maxBotMentionsPerConversation: CONFIG.max_bot_mentions_per_conversation || 10
    });
    (messageReceptor as any).element = space;
    space.addReceptor(messageReceptor);

    const receiptReceptor = new SignalReceiptReceptor();
    (receiptReceptor as any).element = space;
    space.addReceptor(receiptReceptor);

    const typingReceptor = new SignalTypingReceptor();
    (typingReceptor as any).element = space;
    space.addReceptor(typingReceptor);

    // Add speech effector
    const speechEffector = new SignalSpeechEffector({
      apiUrl: process.env.HTTP_BASE_URL || 'http://localhost:8080',
      botNames,
      maxMessageLength: 400
    });
    (speechEffector as any).element = space;
    space.addEffector(speechEffector);

    // Add active stream transform (reads streamId from event payload and sets frame.activeStream)
    const activeStreamTransform = new ActiveStreamTransform();
    await activeStreamTransform.mount(space);

    // Add context transform (builds HUD context for agents)
    const contextTransform = new ContextTransform({});
    await contextTransform.mount(space);

    console.log(`\n✅ ${CONFIG.bots.length} Signal bots initialized\n`);
    console.log('Listening for Signal messages...\n');
  }

  getComponentRegistry(): typeof ComponentRegistry {
    ComponentRegistry.register('SignalAfferent', SignalAfferent);
    return ComponentRegistry;
  }

  async onStart(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('🚀 Signal bots started!\n');
  }

  async onRestore(space: Space, veilState: VEILStateManager): Promise<void> {
    console.log('♻️  Signal bots restored from snapshot\n');

    // Reconnect all afferents
    for (const botElem of space.children) {
      if (botElem.name.startsWith('bot-')) {
        const afferent = botElem.components[0] as SignalAfferent;
        const config = (afferent as any).config || {}; // Access config property directly

        const context: AfferentContext<any> = {
          config,
          afferentId: botElem.id,
          emit: (event) => space.emit(event),
          emitError: (error) => console.error(`[${botElem.name}] Error:`, error)
        };

        await afferent.initialize(context);
        await afferent.start();

        console.log(`✓ Reconnected ${botElem.name}`);
      }
    }
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

  // Create LLM provider
  const llmProvider = new AnthropicProvider({
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

  // Start the host
  try {
    await host.start(app);
  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
}

main();
