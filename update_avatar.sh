#!/bin/bash

# Script to update a Signal bot's profile picture
# Usage: ./update_avatar.sh <phone_number> <image_path>
# Compatible with the Connectome container setup (API on port 8081)

set -e

# Check arguments
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <phone_number> <image_path>"
    echo "Example: $0 +14406167807 /path/to/avatar.jpg"
    exit 1
fi

PHONE_NUMBER="$1"
IMAGE_PATH="$2"
SIGNAL_API_URL="http://localhost:8081"
CONFIG_FILE="config.json"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Bot Avatar Update Script ===${NC}"
echo "Phone Number: $PHONE_NUMBER"
echo "Image Path: $IMAGE_PATH"
echo ""

# Step 1: Validate image file
echo -e "${YELLOW}Step 1: Validating image file...${NC}"

if [ ! -f "$IMAGE_PATH" ]; then
    echo -e "${RED}Error: Image file not found at $IMAGE_PATH${NC}"
    exit 1
fi

# Check file type
FILE_TYPE=$(file -b --mime-type "$IMAGE_PATH")
if [[ ! "$FILE_TYPE" =~ ^image/ ]]; then
    echo -e "${RED}Error: File is not an image (type: $FILE_TYPE)${NC}"
    echo "Supported formats: JPEG, PNG, GIF, WebP"
    exit 1
fi

# Check file size (Signal has limits, typically ~5MB)
FILE_SIZE=$(stat -c%s "$IMAGE_PATH" 2>/dev/null || stat -f%z "$IMAGE_PATH" 2>/dev/null)
MAX_SIZE=$((5 * 1024 * 1024))  # 5MB

if [ "$FILE_SIZE" -gt "$MAX_SIZE" ]; then
    echo -e "${RED}Error: Image file is too large ($(numfmt --to=iec-i --suffix=B $FILE_SIZE))${NC}"
    echo "Maximum size: 5MB"
    echo -e "${YELLOW}Tip: Use 'convert' or 'mogrify' from ImageMagick to resize:${NC}"
    echo "  convert $IMAGE_PATH -resize 640x640^ -quality 85 output.jpg"
    exit 1
fi

echo -e "${GREEN}✓ Image validated${NC}"
echo "  Type: $FILE_TYPE"
echo "  Size: $(numfmt --to=iec-i --suffix=B $FILE_SIZE)"
echo ""

# Step 2: Check if phone number is registered
echo -e "${YELLOW}Step 2: Checking if phone number is registered...${NC}"

ACCOUNTS=$(curl -s "${SIGNAL_API_URL}/v1/accounts")
if ! echo "$ACCOUNTS" | grep -q "$PHONE_NUMBER"; then
    echo -e "${RED}Error: Phone number $PHONE_NUMBER is not registered${NC}"
    echo "Registered accounts:"
    echo "$ACCOUNTS" | jq -r '.[]' 2>/dev/null || echo "$ACCOUNTS"
    exit 1
fi

echo -e "${GREEN}✓ Phone number is registered${NC}"
echo ""

# Step 3: Get current profile name to preserve it
echo -e "${YELLOW}Step 3: Getting current profile name...${NC}"

# Try to get name from config.json first
if [ -f ".env" ] && [ -f "$CONFIG_FILE" ]; then
    source .env
    IFS=',' read -ra PHONE_ARRAY <<< "$BOT_PHONE_NUMBERS"

    # Find the index of this phone number
    BOT_INDEX=-1
    for i in "${!PHONE_ARRAY[@]}"; do
        CLEAN_PHONE=$(echo "${PHONE_ARRAY[$i]}" | tr -d ' ')
        if [ "$CLEAN_PHONE" = "$PHONE_NUMBER" ]; then
            BOT_INDEX=$i
            break
        fi
    done

    if [ $BOT_INDEX -ne -1 ]; then
        CURRENT_NAME=$(jq -r ".bots[$BOT_INDEX].name" "$CONFIG_FILE")
        if [ "$CURRENT_NAME" != "null" ] && [ -n "$CURRENT_NAME" ]; then
            echo "Using bot name from config: $CURRENT_NAME"
        else
            CURRENT_NAME="Bot"
            echo "Using default name: Bot"
        fi
    else
        CURRENT_NAME="Bot"
        echo "Using default name: Bot"
    fi
else
    CURRENT_NAME="Bot"
    echo "Using default name: Bot"
fi
echo ""

# Step 4: Encode image to base64
echo -e "${YELLOW}Step 4: Encoding image to base64...${NC}"

if ! BASE64_IMAGE=$(base64 -w 0 "$IMAGE_PATH" 2>/dev/null || base64 "$IMAGE_PATH" | tr -d '\n'); then
    echo -e "${RED}Error: Failed to encode image to base64${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Image encoded${NC}"
echo ""

# Step 5: Update Signal profile
echo -e "${YELLOW}Step 5: Updating Signal profile avatar...${NC}"

# Create JSON payload using a temp file to avoid argument list too long error
TEMP_JSON=$(mktemp)
trap "rm -f $TEMP_JSON" EXIT

cat > "$TEMP_JSON" <<EOF
{
  "base64_avatar": "$BASE64_IMAGE",
  "name": "$CURRENT_NAME"
}
EOF

# Send update request
RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "${SIGNAL_API_URL}/v1/profiles/${PHONE_NUMBER}" \
    -H "Content-Type: application/json" \
    -d @"$TEMP_JSON")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ] || [ -z "$BODY" ]; then
    echo -e "${GREEN}✓ Avatar updated successfully${NC}"
else
    echo -e "${RED}Error: Failed to update Signal profile${NC}"
    echo "HTTP Code: $HTTP_CODE"
    echo "Response: $BODY"
    exit 1
fi

echo ""
echo -e "${GREEN}=== Avatar updated successfully! ===${NC}"
echo "Phone: $PHONE_NUMBER"
echo "Image: $IMAGE_PATH"
echo "Profile name: ${CURRENT_NAME:-"(empty)"}"
echo ""
echo -e "${YELLOW}Note: The avatar change may take a few moments to propagate to other Signal clients.${NC}"
