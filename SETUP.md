# Signal AXON Host - Setup Guide

## Overview

**signal-axon-host** is a Connectome-native Signal messenger application that runs multiple AI chatbots on Signal using the Connectome framework.

This is a complete rewrite of the Node.js Signal bot implementation using pure Connectome patterns and VEIL-based state management.

## Architecture

```
signal-axon-host (this repository)
    ↓ depends on
signal-axon (MARTEM components for Signal)
    ↓ depends on
connectome-ts (Connectome framework)
    ↓ depends on
connectome-axon-interfaces (shared interfaces)
```

## Requirements

### 1. **Connectome Framework**
Location: `../connectome-ts`
- Core framework providing VEIL state management, MARTEM architecture, agents
- Must be built before using signal-axon

### 2. **Connectome AXON Interfaces**
Location: `../connectome-axon-interfaces`
- Shared interface definitions for AXON modules
- Must be built before connectome-ts

### 3. **Signal AXON Module**
Location: `../signal-axon`
- Provides Signal-specific MARTEM components:
  - `SignalAfferent`: WebSocket connection manager
  - `SignalMessageReceptor`: Converts Signal events to VEIL facets
  - `SignalSpeechEffector`: Sends VEIL speech facets to Signal API
  - `SignalReceiptReceptor`: Handles read receipts
  - `SignalTypingReceptor`: Handles typing indicators
- Must be built before signal-axon-host

### 4. **Signal CLI REST API**
Docker container: `bbernhard/signal-cli-rest-api`
- Provides HTTP and WebSocket API for Signal messenger
- Must be running before starting the host

### 5. **Node.js & npm**
- Node.js 20+ recommended
- TypeScript 5.3+

## Installation

### Step 1: Build Dependencies

```bash
# Build in order (dependencies first)
cd ../connectome-axon-interfaces
npm install
npm run build

cd ../connectome-ts
npm install
npm run build

cd ../signal-axon
npm install
npm run build

cd ../signal-axon-host
npm install
npm run build
```

### Step 2: Configure Environment

Create `.env` file:
```bash
# Signal CLI WebSocket and HTTP endpoints
WS_BASE_URL=ws://localhost:8080
HTTP_BASE_URL=http://localhost:8080

# Comma-separated list of bot phone numbers (must match config.json bots array length)
BOT_PHONE_NUMBERS=+1234567890,+0987654321,+1122334455

# Anthropic API key for LLM
ANTHROPIC_API_KEY=sk-ant-...
```

### Step 3: Configure Bots

Edit `config.json`:
```json
{
  "bots": [
    {
      "name": "haiku-bot",
      "model": "(6) claude-haiku-4-5-20251001",
      "prompt": "(1) Standard",
      "persist_history": false,
      "tools": ["fetch"]
    }
  ],
  "max_history_messages": 200,
  "group_privacy_mode": "opt-out",
  "random_reply_chance": 100,
  "max_bot_mentions_per_conversation": 1
}
```

**Important**: The number of phone numbers in `BOT_PHONE_NUMBERS` must match the length of the `bots` array.

### Step 4: Start Signal CLI

```bash
docker run -d \
  --name signal-cli \
  -p 8080:8080 \
  -v signal-cli-data:/home/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api:latest
```

Register phone numbers with Signal CLI (see Signal CLI documentation).

### Step 5: Run the Host

#### Option A: Local Development

```bash
# Production mode
npm start

# Development mode (auto-reload)
npm run dev

# Reset state and start fresh
npm start -- --reset
```

#### Option B: Docker (Recommended for Production)

```bash
# Build and start both Signal CLI and bot
docker-compose up -d

# View logs
docker-compose logs -f bot

# Stop
docker-compose down

# Rebuild after code changes
docker-compose up -d --build
```

**Docker Notes**:
- Shares Signal CLI data volume with Node.js bot at `${HOME}/.local/share/signal-api`
- Bot state persisted in `./signal-bot-state/` (mounted volume)
- Signal API exposed on port 8081 (vs 8080 for Node.js bot to avoid conflicts)
- Environment variables in `.env` are used, but `WS_BASE_URL` and `HTTP_BASE_URL` are overridden to use container network

## Configuration Options

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WS_BASE_URL` | Signal CLI WebSocket URL | `ws://localhost:8080` |
| `HTTP_BASE_URL` | Signal CLI HTTP URL | `http://localhost:8080` |
| `BOT_PHONE_NUMBERS` | Comma-separated phone numbers | Required |
| `ANTHROPIC_API_KEY` | Anthropic API key | Required |

### config.json

| Field | Description | Default |
|-------|-------------|---------|
| `bots[]` | Array of bot configurations | Required |
| `bots[].name` | Bot display name | Required |
| `bots[].model` | LLM model identifier | `(6) claude-haiku-4-5-20251001` |
| `bots[].prompt` | System prompt key | `(1) Standard` |
| `bots[].persist_history` | Whether to persist history | `false` |
| `bots[].tools` | Array of tool names (e.g., `["fetch"]`) | `[]` |
| `max_history_messages` | Max messages in context | `200` |
| `group_privacy_mode` | `opt-in` or `opt-out` | `opt-in` |
| `random_reply_chance` | 0-100 (percentage) | `0` |
| `max_bot_mentions_per_conversation` | Max bot replies before requiring mention | `10` |

## Features

### Group Chat Privacy Modes

**opt-in** (default):
- Bot only responds when @mentioned or quoted
- Random reply chance still applies

**opt-out**:
- Bot responds to all messages by default
- Users can opt out (creates `user-preferences` facet with `optedOut: true`)
- Still responds when @mentioned even if opted out

### Random Reply Chance

Set `random_reply_chance` to 0-100:
- `0`: Never randomly reply
- `100`: Always reply (if privacy mode allows)
- `50`: 50% chance to reply

Only applies in group chats when bot is NOT mentioned.

### Max Bot Mentions

After bot has replied N times in a conversation (where N = `max_bot_mentions_per_conversation`):
- Requires explicit @mention or quote to respond again
- Prevents bots from dominating conversations
- Config value of `1` means: bot replies once, then requires mention

### Tools

Available tools:
- `fetch`: Fetch content from URLs via HTTP

Enable per bot in config.json:
```json
{
  "tools": ["fetch"]
}
```

### Persistence

All conversation state is stored in `./signal-bot-state/`:
- VEIL facets (messages, user profiles, preferences)
- Frame history
- Agent state

State survives restarts automatically.

## Troubleshooting

### "No LLM provider found"
- Ensure `ANTHROPIC_API_KEY` is set in `.env`

### "No bot phone numbers configured"
- Ensure `BOT_PHONE_NUMBERS` is set in `.env`
- Ensure count matches `bots` array length in `config.json`

### "WebSocket connection failed"
- Ensure Signal CLI container is running
- Check `WS_BASE_URL` in `.env`
- Verify Signal CLI is accessible: `curl http://localhost:8080/v1/health`

### "Cannot find module 'connectome-ts'"
- Build dependencies in order (see Step 1)
- Check that `../connectome-ts/dist/` exists

### "Module not found: signal-axon"
- Build signal-axon: `cd ../signal-axon && npm run build`

### Docker build fails with "COPY failed"
- Ensure parent directories exist: `connectome-axon-interfaces`, `connectome-ts`, `signal-axon`
- Run `docker-compose build --no-cache` to rebuild from scratch

### Docker bot container exits immediately
- Check logs: `docker-compose logs bot`
- Verify `.env` file exists with required variables
- Ensure config.json is present

### Can't access Signal API from Docker container
- Container uses internal network: `signal-api:8080`
- Host machine uses: `localhost:8081`
- Don't override `WS_BASE_URL`/`HTTP_BASE_URL` in `.env` when using Docker

## Debug UI

Debug server runs on `http://localhost:3003` when enabled in code.

View:
- VEIL state
- Frame history
- Active facets
- Event streams

## Differences from Node.js Version

| Feature | Node.js | Connectome |
|---------|---------|------------|
| State management | In-memory objects | VEIL facets (persistent) |
| Message routing | Phone number lookups | Stream facets |
| Agent integration | Custom handler | AgentEffector + ContextTransform |
| Reconnection | Manual exponential backoff | Built into SignalAfferent |
| Multi-bot consistency | Custom deduplication | Facet ID-based |
| Configuration | Mixed (code + config) | Pure data-driven |
| Tool system | Custom implementation | Connectome ToolDefinition |
| Persistence | None | Automatic via VEIL snapshots |

## Directory Structure

```
signal-axon-host/
├── src/
│   ├── signal-host.ts    # Main application entry point
│   └── tools.ts          # Tool definitions (fetch)
├── config.json           # Bot configurations
├── .env                  # Environment variables
├── package.json
├── tsconfig.json
├── README.md             # User documentation
└── SETUP.md             # This file
```

## Architecture Notes

### MARTEM Pipeline

1. **Afferent**: SignalAfferent receives WebSocket messages
2. **Modulator**: (none currently)
3. **Receptor**: SignalMessageReceptor creates VEIL facets
4. **Transform**: ContextTransform builds agent context
5. **Effector**:
   - AgentEffector runs agent → creates speech facets
   - SignalSpeechEffector sends speech → Signal API
6. **Maintainer**: ElementTreeMaintainer manages element lifecycle

### VEIL Facets

**user-profile**:
```typescript
{
  type: 'user-profile',
  content: 'Display Name',
  attributes: {
    phoneNumber: '+1234567890',
    uuid: 'user-uuid',
    displayName: 'Display Name',
    platform: 'signal'
  }
}
```

**user-preferences**:
```typescript
{
  type: 'user-preferences',
  attributes: {
    userId: '+1234567890',
    conversationKey: 'group-id',
    botPhone: '+0987654321',
    optedOut: true
  }
}
```

**stream-definition**:
```typescript
{
  type: 'stream-definition',
  content: 'DM with Alice',
  attributes: {
    streamType: 'signal',
    conversationKey: '+1234567890',
    isGroupChat: false,
    botPhone: '+0987654321'
  }
}
```

## License

MIT
