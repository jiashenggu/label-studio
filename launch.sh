#!/bin/bash
#
# Launch Label Studio with optional frame server for image sequence support
#
# Usage:
#   ./launch.sh                    # Launch Label Studio only (lerobot mode)
#   ./launch.sh --packds           # Launch with LanceDB frame server (packds mode)
#

set -e

# Configuration
LABEL_STUDIO_PORT=8111
FRAME_SERVER_PORT=8765
LANCEDB_PATH="${LANCEDB_PATH:-/home/gear/lerobot_lancedb}"
# docker
# API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoicmVmcmVzaCIsImV4cCI6ODA3MDYzNDg2MCwiaWF0IjoxNzYzNDM0ODYwLCJqdGkiOiJkMzQ3MDlkMWY4MDk0YTg0YmUwMGNhYTAxOGQwODVmMyIsInVzZXJfaWQiOiI0In0.OT8fXRdhod6MOWJl6UUS_m1wIOMoPj_KkTxAR8Mz4AE"
# local
API_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoicmVmcmVzaCIsImV4cCI6ODA3NjYxOTg4OCwiaWF0IjoxNzY5NDE5ODg4LCJqdGkiOiJlMzllNDdmOTU1ODQ0NDllOTc5YTBiMjRkMWRjZGNiYSIsInVzZXJfaWQiOiIxIn0.JwaxWqNQ7VxeS0rbLBcGAWstG_vz5kFTxDt3VgEMFWk"

# AWS/S3 credentials for lerobot mode
export AWS_ACCESS_KEY_ID="jiashenggu:AUTH_team-gear"
export AWS_SECRET_ACCESS_KEY="a950a4265f9d79628dc188ebb3a0eb4d"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ENDPOINT_URL="https://pdx.s8k.io"
export S3_ENDPOINT_URL="https://pdx.s8k.io"

# Parse arguments
MODE="lerobot"
FPS=15.0
MAX_EPISODES=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --packds)
            MODE="packds"
            shift
            ;;
        --lancedb-path)
            LANCEDB_PATH="$2"
            shift 2
            ;;
        --fps)
            FPS="$2"
            shift 2
            ;;
        --max-episodes)
            MAX_EPISODES="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: ./launch.sh [--packds] [--lancedb-path PATH] [--fps N] [--max-episodes N]"
            exit 1
            ;;
    esac
done

echo "========================================"
echo "🏷️  Label Studio Launcher"
echo "========================================"
echo "Mode: $MODE"
echo ""

# # Stop existing containers
# echo "🧹 Cleaning up existing containers..."
# sudo docker rm -f ls 2>/dev/null || true

# # Start Label Studio
# echo "🚀 Starting Label Studio..."
# sudo docker run -d \
#     -u $(id -u):$(id -g) \
#     --name ls \
#     --env-file ls.env \
#     -p 0.0.0.0:${LABEL_STUDIO_PORT}:8080 \
#     -v $(pwd)/mydata:/label-studio/data \
#     -v ~/Videos/lerobot_storage:/home/gear/Videos/lerobot_storage \
#     scruple/label-studio:latest \
#     label-studio \
#     --log-level DEBUG

# Wait for Label Studio to be ready
echo "⏳ Waiting for Label Studio to start..."
until curl -s http://localhost:${LABEL_STUDIO_PORT}/health > /dev/null; do
    sleep 1
done
echo "✓ Label Studio is ready at http://localhost:${LABEL_STUDIO_PORT}"

if [ "$MODE" = "lerobot" ]; then
    # LeRobot mode - create tasks from S3 videos
    echo ""
    echo "📹 Creating tasks from S3 videos..."
    python create_tasks.py \
        --mode lerobot \
        --dataset_dir s3://GrootDatasets/yam_lerobot_v5/xdof.assembly_2026-01-26_05-42-20_v4_USA \
        --api_key "$API_KEY"
        
    echo ""
    echo "✅ Done! Open http://localhost:${LABEL_STUDIO_PORT}"
    
elif [ "$MODE" = "packds" ]; then
    # PackDS mode - start frame server and create tasks with image sequences
    # All views and all episodes are included automatically
    echo ""
    echo "📦 PackDS mode - Starting frame server..."
    echo "   LanceDB: $LANCEDB_PATH"
    echo "   FPS: $FPS"
    if [ -n "$MAX_EPISODES" ]; then
        echo "   Max episodes: $MAX_EPISODES"
    else
        echo "   Episodes: all"
    fi
    echo ""
    
    # Build optional arguments
    EXTRA_ARGS=""
    if [ -n "$MAX_EPISODES" ]; then
        EXTRA_ARGS="$EXTRA_ARGS --max-episodes $MAX_EPISODES"
    fi
    
    # Run frame server (this will block and keep serving frames)
    python frame_server.py \
        --api-key "$API_KEY" \
        --base-url "http://localhost:${LABEL_STUDIO_PORT}" \
        --lancedb-path "$LANCEDB_PATH" \
        --fps "$FPS" \
        --frame-server-port "$FRAME_SERVER_PORT" \
        $EXTRA_ARGS
fi
