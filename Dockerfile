FROM node:20-slim

# Install build dependencies
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Copy all dependencies from parent directory (build context is parent)
COPY connectome-axon-interfaces ./connectome-axon-interfaces
COPY connectome-ts ./connectome-ts
COPY signal-axon ./signal-axon
COPY signal-axon-host ./signal-axon-host

# Build dependencies in order
WORKDIR /workspace/connectome-axon-interfaces
RUN npm install && npm run build

WORKDIR /workspace/connectome-ts
RUN npm install && npm run build

WORKDIR /workspace/signal-axon
RUN npm install && npm run build

# Install and build signal-axon-host
WORKDIR /workspace/signal-axon-host
RUN npm install && npm run build

# Create directory for state persistence
RUN mkdir -p /workspace/signal-axon-host/signal-bot-state

# Allocate max heap for Node (server has ~8GB RAM, leave ~2GB for OS)
ENV NODE_OPTIONS="--max-old-space-size=6144"

# Run the application
CMD ["npm", "start"]
