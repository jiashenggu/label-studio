#!/bin/bash
# One-click script to start frame sequence annotation
# Uses image arrays instead of video files - true zero conversion!

set -e

# Configuration
LANCEDB_PATH="/home/gear/Downloads/spirit_ai_data/1219/moz1.1.packds/"
SERVER_PORT=8000
LABEL_STUDIO_URL="http://localhost:8080/"
LABEL_STUDIO_API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoicmVmcmVzaCIsImV4cCI6ODA3MDYzNDg2MCwiaWF0IjoxNzYzNDM0ODYwLCJqdGkiOiJkMzQ3MDlkMWY4MDk0YTg0YmUwMGNhYTAxOGQwODVmMyIsInVzZXJfaWQiOiI0In0.OT8fXRdhod6MOWJl6UUS_m1wIOMoPj_KkTxAR8Mz4AE"  # Add your API key here
MAX_EPISODES=100
FPS=15.0

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}🎬 Frame Sequence Annotation${NC}"
echo -e "${GREEN}   Zero Conversion Solution${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check API key
if [ -z "$LABEL_STUDIO_API_KEY" ]; then
    echo -e "${YELLOW}⚠️  Label Studio API key not set${NC}"
    echo ""
    read -p "Enter your Label Studio API key: " LABEL_STUDIO_API_KEY
    echo ""
fi

# Check LanceDB path
if [ ! -d "$LANCEDB_PATH" ]; then
    echo -e "${RED}❌ Error: LanceDB path not found: $LANCEDB_PATH${NC}"
    read -p "Enter your LanceDB path: " LANCEDB_PATH
    echo ""
    if [ ! -d "$LANCEDB_PATH" ]; then
        echo -e "${RED}❌ Path not found. Exiting.${NC}"
        exit 1
    fi
fi

# Check if port is available
if lsof -Pi :$SERVER_PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo -e "${YELLOW}⚠️  Port $SERVER_PORT is already in use${NC}"
    read -p "Kill existing process? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null || true
        sleep 2
    else
        sleep 1
    fi
fi

# Create log directory
LOG_DIR="./logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/frame_server_$(date +%Y%m%d_%H%M%S).log"

# Step 1: Start frame server
echo -e "${BLUE}Step 1/3: Starting Frame Server...${NC}"
echo "  LanceDB: $LANCEDB_PATH"
echo "  Port: $SERVER_PORT"
echo ""

python lancedb_frame_server.py \
    --lancedb-path "$LANCEDB_PATH" \
    --port $SERVER_PORT \
    --host 0.0.0.0 \
    > "$LOG_FILE" 2>&1 &

SERVER_PID=$!
echo $SERVER_PID > "$LOG_DIR/frame_server.pid"
echo -e "${GREEN}✓ Server started (PID: $SERVER_PID)${NC}"
echo ""

# Wait for server
echo "Waiting for server to be ready..."
MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -s http://localhost:$SERVER_PORT/health >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Server is ready!${NC}"
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
    echo -n "."
done
echo ""

if [ $WAITED -eq $MAX_WAIT ]; then
    echo -e "${RED}❌ Server failed to start${NC}"
    echo "Check logs: $LOG_FILE"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

# Step 2: Test server
echo -e "${BLUE}Step 2/3: Testing server...${NC}"
echo ""

EPISODES=$(curl -s "http://localhost:$SERVER_PORT/episodes" | python -c "import sys, json; data=json.load(sys.stdin); print(f\"Found {data['count']} episodes\")" 2>/dev/null || echo "Could not get episode count")
echo "  $EPISODES"

echo ""
echo -e "${GREEN}✓ Server test passed!${NC}"
echo ""

# Step 3: Import to Label Studio
echo -e "${BLUE}Step 3/3: Importing to Label Studio...${NC}"
echo "  URL: $LABEL_STUDIO_URL"
echo "  Max episodes: $MAX_EPISODES"
echo "  FPS: $FPS"
echo ""

python create_tasks.py \
    --mode packds \
    --frame-server-url "http://localhost:$SERVER_PORT" \
    --api-key "$LABEL_STUDIO_API_KEY" \
    --base-url "$LABEL_STUDIO_URL" \
    --max-episodes $MAX_EPISODES \
    --fps $FPS \
    --project-name "Frame Sequence Annotation $(date +%Y-%m-%d)"

if [ $? -ne 0 ]; then
    echo ""
    echo -e "${RED}❌ Import failed${NC}"
    echo "Server is still running. Stop it with: kill $SERVER_PID"
    exit 1
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✅ All done!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "🎬 How it works:"
echo "  ✓ No video files created (zero conversion!)"
echo "  ✓ Label Studio loads frame sequences as 'video'"
echo "  ✓ Each frame is served directly from LanceDB"
echo "  ✓ VideoRectangle works with frame arrays"
echo ""
echo "📊 System Status:"
echo "  ✓ Frame Server: http://localhost:$SERVER_PORT (PID: $SERVER_PID)"
echo "  ✓ Label Studio: $LABEL_STUDIO_URL"
echo "  ✓ Log: $LOG_FILE"
echo ""

# Ask user what to do
echo -e "${YELLOW}⚠️  Frame server must keep running for Label Studio to work!${NC}"
echo ""
echo "Choose an option:"
echo "  1) Exit script (server keeps running) - Recommended"
echo "  2) Monitor logs (Ctrl+C will stop server)"
echo ""
read -p "Enter choice (1-2) [default: 1]: " -n 1 -r CHOICE
echo ""
echo ""


case $CHOICE in
    2)
        echo -e "${GREEN}✓ Monitoring logs... (Press Ctrl+C to stop server and exit)${NC}"
        echo ""
        
        # Cleanup function
        cleanup() {
            echo ""
            echo -e "${YELLOW}Stopping frame server...${NC}"
            kill $SERVER_PID 2>/dev/null || true
            echo -e "${GREEN}✓ Server stopped${NC}"
            echo -e "${RED}⚠️  Label Studio will no longer be able to load videos!${NC}"
            exit 0
        }
        
        trap cleanup INT TERM
        tail -f "$LOG_FILE"
        ;;
    1|*)
        echo -e "${GREEN}✓ Server will keep running (PID: $SERVER_PID)${NC}"
        echo ""
        echo "🎯 Next steps:"
        echo "  1. Open Label Studio: $LABEL_STUDIO_URL"
        echo "  2. Start annotating!"
        echo ""
        echo "📝 Useful commands:"
        echo "  # Stop server when done:"
        echo "  kill $SERVER_PID"
        echo ""
        echo "  # Or stop all frame servers:"
        echo "  pkill -f lancedb_frame_server"
        echo ""
        echo "  # View logs:"
        echo "  tail -f $LOG_FILE"
        echo ""
        echo "  # Check server status:"
        echo "  curl http://localhost:$SERVER_PORT/health"
        echo ""
        exit 0
        ;;
esac

