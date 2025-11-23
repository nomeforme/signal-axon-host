FROM node:20-slim

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files for all dependencies
COPY package*.json ./

# Copy local dependencies (connectome-ts, signal-axon, connectome-axon-interfaces)
COPY ../connectome-axon-interfaces /deps/connectome-axon-interfaces
COPY ../connectome-ts /deps/connectome-ts
COPY ../signal-axon /deps/signal-axon

# Build dependencies in order
WORKDIR /deps/connectome-axon-interfaces
RUN npm install && npm run build

WORKDIR /deps/connectome-ts
RUN npm install && npm run build

WORKDIR /deps/signal-axon
RUN npm install && npm run build

# Install signal-axon-host dependencies
WORKDIR /app
RUN npm install

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build the application
RUN npm run build

# Create directory for state persistence
RUN mkdir -p /app/signal-bot-state

# Run the application
CMD ["npm", "start"]
