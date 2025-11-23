# Docker Quick Reference

## Starting

```bash
# Start both Signal CLI and bot
docker-compose up -d

# Start and rebuild
docker-compose up -d --build

# Start with logs visible
docker-compose up
```

## Monitoring

```bash
# View logs (follow mode)
docker-compose logs -f

# View bot logs only
docker-compose logs -f bot

# View Signal API logs only
docker-compose logs -f signal-api

# View last 100 lines
docker-compose logs --tail=100 bot
```

## Stopping

```bash
# Stop containers (keeps volumes)
docker-compose down

# Stop and remove volumes (clears state)
docker-compose down -v
```

## Debugging

```bash
# Check container status
docker-compose ps

# Execute command in bot container
docker-compose exec bot sh

# View bot environment variables
docker-compose exec bot env

# Restart just the bot
docker-compose restart bot

# Rebuild bot only
docker-compose up -d --build bot
```

## Cleanup

```bash
# Remove all containers and volumes
docker-compose down -v

# Rebuild from scratch (no cache)
docker-compose build --no-cache

# Remove dangling images
docker image prune -f
```

## Troubleshooting

### Bot won't start

```bash
# Check logs
docker-compose logs bot

# Check if Signal API is healthy
docker-compose ps signal-api

# Restart both services
docker-compose restart
```

### Signal CLI connection issues

```bash
# Check Signal API health endpoint
curl http://localhost:8081/v1/about

# View Signal API logs
docker-compose logs signal-api

# Restart Signal API
docker-compose restart signal-api
```

### State persistence issues

```bash
# Check if volume exists
docker volume ls | grep signal

# Inspect volume
docker volume inspect signal-axon-host_signal-bot-state

# Clear state and restart
docker-compose down -v
docker-compose up -d
```

## Ports

- **8081**: Signal CLI REST API (host machine)
- **8080**: Signal CLI REST API (container network)
- **3003**: Debug UI (if enabled)

## Volumes

- `${HOME}/.local/share/signal-api`: Signal CLI account data (shared with Node.js bot)
- `./signal-bot-state`: VEIL state persistence (Connectome snapshots)

## Network

Both containers run on the same Docker network:
- Bot accesses Signal API via `signal-api:8080` (internal DNS)
- Host machine accesses Signal API via `localhost:8081`

## Environment Variables

The bot container uses:
1. Variables from `.env` file
2. Overrides from `docker-compose.yml`:
   - `WS_BASE_URL=ws://signal-api:8080`
   - `HTTP_BASE_URL=http://signal-api:8080`

To override, edit `docker-compose.yml` environment section.
