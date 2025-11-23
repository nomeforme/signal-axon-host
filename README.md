# Signal AXON Host

Connectome-native Signal messenger host application.

## Overview

This is a clean-slate implementation of Signal bots using the Connectome framework and the signal-axon module. It replaces the Node.js implementation with a fully VEIL-native architecture.

## Architecture

- **ConnectomeHost**: Infrastructure layer (persistence, LLM providers, debug UI)
- **SignalApplication**: Application logic (bot initialization, element creation)
- **signal-axon components**: MARTEM architecture for Signal integration
  - SignalAfferent: WebSocket connection management
  - SignalMessageReceptor: Events → VEIL facets
  - SignalSpeechEffector: Speech facets → Signal API

## Configuration

Uses the same config.json format as the original Node.js implementation:

```json
{
  "bots": [
    {
      "name": "haiku-4-5",
      "model": "(6) claude-haiku-4-5-20251001",
      "prompt": "(1) Standard",
      "persist_history": false,
      "tools": ["fetch"]
    }
  ],
  "max_history_messages": 200,
  "group_privacy_mode": "opt-out",
  "session_timeout": 30
}
```

Environment variables (.env):
- `BOT_PHONE_NUMBERS`: Comma-separated list of bot phone numbers
- `ANTHROPIC_API_KEY`: Your Anthropic API key
- `WS_BASE_URL`: Signal CLI WebSocket URL (default: ws://localhost:8080)
- `HTTP_BASE_URL`: Signal CLI HTTP URL (default: http://localhost:8080)

## Quick Start

### With Docker (Recommended)

```bash
# 1. Copy config files
cp ../signal-ai-chat-bot-js/config.json .
cp ../signal-ai-chat-bot-js/.env .

# 2. Start everything
docker-compose up -d

# 3. View logs
docker-compose logs -f bot
```

### Without Docker (Local Development)

```bash
# 1. Build dependencies (one-time setup)
cd ../connectome-axon-interfaces && npm install && npm run build
cd ../connectome-ts && npm install && npm run build
cd ../signal-axon && npm install && npm run build

# 2. Install and build
cd ../signal-axon-host
npm install
npm run build

# 3. Copy config files
cp ../signal-ai-chat-bot-js/config.json .
cp ../signal-ai-chat-bot-js/.env .

# 4. Start the host
npm start

# Development mode with auto-reload
npm run dev
```

See [SETUP.md](SETUP.md) for detailed installation and configuration instructions.

## How It Works

1. **Initialization**: Reads config.json and creates a Space Element for each bot
2. **Afferent Setup**: Each bot gets a SignalAfferent component for WebSocket connection
3. **Event Processing**: Incoming Signal messages → events → receptors → VEIL facets
4. **Agent Activation**: Message facets trigger agent activations
5. **Response**: Agent generates speech facets → effector → Signal API

## Persistence

All conversation state is stored in VEIL facets and persisted to `./signal-bot-state/`:
- Message history
- User preferences
- Conversation context
- Agent state

State survives restarts automatically.

## Debug UI

Debug server runs on http://localhost:3003 when enabled.

## Differences from Node.js Version

| Feature | Node.js | Connectome |
|---------|---------|------------|
| State management | In-memory objects | VEIL facets (persistent) |
| Message routing | Phone number lookups | Stream-based VEIL facets |
| Agent integration | Custom message handler | AgentEffector + ContextTransform |
| Reconnection | Manual exponential backoff | Built into SignalAfferent |
| Multi-bot consistency | Custom deduplication | Facet ID-based deduplication |
| Configuration | Mixed (code + config) | Pure data-driven (config.json) |

## License

MIT
# signal-axon-host
