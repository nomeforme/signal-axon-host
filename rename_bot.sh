#!/bin/bash

# Script to rename a Signal bot's profile name and update config.json
# Usage: ./rename_bot.sh <phone_number> <new_name>
# Compatible with the Connectome container setup (API on port 8081)

set -e

# Check arguments
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <phone_number> <new_name>"
    echo "Example: $0 +14406167807 \"claude-3-haiku\""
    exit 1
fi

PHONE_NUMBER="$1"
NEW_NAME="$2"
CONFIG_FILE="config.json"
SIGNAL_API_URL="http://localhost:8081"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Bot Renaming Script ===${NC}"
echo "Phone Number: $PHONE_NUMBER"
echo "New Name: $NEW_NAME"
echo ""

# Step 1: Find the bot in config.json
echo -e "${YELLOW}Step 1: Checking config.json...${NC}"

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}Error: config.json not found${NC}"
    exit 1
fi

# Check if .env exists and has BOT_PHONE_NUMBERS
if [ ! -f ".env" ]; then
    echo -e "${RED}Error: .env file not found${NC}"
    exit 1
fi

# Load phone numbers from .env
source .env
IFS=',' read -ra PHONE_ARRAY <<< "$BOT_PHONE_NUMBERS"

# Find the index of this phone number
BOT_INDEX=-1
for i in "${!PHONE_ARRAY[@]}"; do
    # Remove spaces
    CLEAN_PHONE=$(echo "${PHONE_ARRAY[$i]}" | tr -d ' ')
    if [ "$CLEAN_PHONE" = "$PHONE_NUMBER" ]; then
        BOT_INDEX=$i
        break
    fi
done

if [ $BOT_INDEX -eq -1 ]; then
    echo -e "${RED}Error: Phone number $PHONE_NUMBER not found in .env BOT_PHONE_NUMBERS${NC}"
    exit 1
fi

echo "Found phone number at index $BOT_INDEX in .env"

# Get the current bot name from config.json
CURRENT_NAME=$(jq -r ".bots[$BOT_INDEX].name" "$CONFIG_FILE")

if [ "$CURRENT_NAME" = "null" ]; then
    echo -e "${RED}Error: Bot at index $BOT_INDEX not found in config.json${NC}"
    exit 1
fi

echo "Current name in config.json: $CURRENT_NAME"
echo ""

# Step 2: Update config.json
echo -e "${YELLOW}Step 2: Updating config.json...${NC}"

# Create a temporary file with the updated config
jq ".bots[$BOT_INDEX].name = \"$NEW_NAME\"" "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"

# Verify the update was successful
UPDATED_NAME=$(jq -r ".bots[$BOT_INDEX].name" "${CONFIG_FILE}.tmp")
if [ "$UPDATED_NAME" = "$NEW_NAME" ]; then
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    echo -e "${GREEN}✓ Updated config.json${NC}"
else
    rm "${CONFIG_FILE}.tmp"
    echo -e "${RED}Error: Failed to update config.json${NC}"
    exit 1
fi

echo ""

# Step 3: Update Signal profile via REST API (name only, preserve avatar)
echo -e "${YELLOW}Step 3: Updating Signal profile name (preserving avatar)...${NC}"

# The API requires base64_avatar field, but we can omit it to preserve existing
# Using PATCH-like behavior by not including avatar
RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "${SIGNAL_API_URL}/v1/profiles/${PHONE_NUMBER}" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$NEW_NAME\"}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ] || [ -z "$BODY" ]; then
    echo -e "${GREEN}✓ Updated Signal profile name${NC}"
else
    echo -e "${RED}Error: Failed to update Signal profile${NC}"
    echo "HTTP Code: $HTTP_CODE"
    echo "Response: $BODY"
    echo ""
    echo -e "${YELLOW}Note: config.json has been updated, but Signal profile update failed.${NC}"
    echo "You may need to update the Signal profile manually."
    exit 1
fi

echo ""
echo -e "${GREEN}=== Bot renamed successfully! ===${NC}"
echo "Phone: $PHONE_NUMBER"
echo "Old name: $CURRENT_NAME"
echo "New name: $NEW_NAME"
echo ""
echo -e "${YELLOW}Note: If the bot is currently running, restart it for changes to take effect.${NC}"
