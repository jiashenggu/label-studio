#!/bin/bash
#
# Launch Label Studio with optional frame server for image sequence support
#
# Usage:
#   ./launch.sh                                 # Docker only (no dataset processing)
#   ./launch.sh --prod                          # Docker only, production mode
#   ./launch.sh --dataset-dir PATH              # LeRobot mode (S3 videos)
#   ./launch.sh --dataset-dir PATH --packds     # PackDS mode (LanceDB frames)
#   ./launch.sh --prod --dataset-dir PATH       # Use production port (8080)
#   ./launch.sh --web                           # Proxy :8110 → local dev LS :8111
#   ./launch.sh --web --prod                    # Proxy :8080 → Docker LS :8081
#

set -e

# =============================================================================
# Configuration
# =============================================================================

# Set to true for production (port 8080), false for development (port 8111)
USE_PRODUCTION=false

FRAME_SERVER_PORT=8765
DATASET_DIR="${DATASET_DIR:-}"

# API keys for different environments
API_KEY_PROD=""
API_KEY_DEV=""

# AWS/S3 credentials for lerobot mode
export AWS_ACCESS_KEY_ID=""
export AWS_SECRET_ACCESS_KEY=""
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ENDPOINT_URL="https://pdx.s8k.io"
export S3_ENDPOINT_URL="https://pdx.s8k.io"

# =============================================================================
# Parse arguments
# =============================================================================

MODE="lerobot"
FPS=30.0
MAX_EPISODES=""
USE_WEB_SERVER=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --packds)
            MODE="packds"
            shift
            ;;
        --lerobot)
            MODE="lerobot"
            shift
            ;;
        --prod|--production)
            USE_PRODUCTION=true
            shift
            ;;
        --dev|--development)
            USE_PRODUCTION=false
            shift
            ;;
        --dataset-dir|--dataset_dir)
            DATASET_DIR="$2"
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
        --web)
            USE_WEB_SERVER=true
            shift
            ;;
        -h|--help)
            echo "Usage: ./launch.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dataset-dir PATH    Dataset directory (optional)"
            echo "                        - If omitted, only docker operations will be performed"
            echo "                        - lerobot: S3 path (s3://bucket/path) or local path"
            echo "                        - packds: Path to LanceDB database"
            echo "  --packds              Use PackDS mode (LanceDB frame sequences)"
            echo "  --lerobot             Use LeRobot mode (S3/local videos, default)"
            echo "  --prod, --production  Use production port (8080, Docker)"
            echo "  --dev, --development  Use development port (8111, local)"
            echo "  --web                 Reverse proxy with dataset import"
            echo "                        --web        → proxy :8110 → local LS :8111 (dev)"
            echo "                        --web --prod → proxy :8080 → Docker LS :8081 (prod)"
            echo "  --fps N               Frame rate for playback (default: 15)"
            echo "  --max-episodes N      Maximum episodes to import (packds only)"
            echo ""
            echo "Examples:"
            echo "  ./launch.sh                                           # Docker only"
            echo "  ./launch.sh --prod                                    # Docker only (production)"
            echo "  ./launch.sh --dataset-dir s3://bucket/lerobot_dataset"
            echo "  ./launch.sh --packds --dataset-dir /path/to/lancedb"
            echo "  ./launch.sh --prod --packds --dataset-dir /path/to/lancedb"
            echo "  ./launch.sh --web                                    # :8110 proxy → local (dev)"
            echo "  ./launch.sh --web --prod                             # :8080 proxy → Docker (prod)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Validate arguments
# If dataset_dir is empty, only docker operations will be performed
if [ -z "$DATASET_DIR" ]; then
    echo "⚠️  No dataset directory specified - only docker operations will be performed"
    echo ""
fi

# Set port and API key based on environment
if [ "$USE_PRODUCTION" = true ]; then
    LABEL_STUDIO_PORT=8080
    API_KEY="$API_KEY_PROD"
    ENV_NAME="Production (Docker)"
else
    LABEL_STUDIO_PORT=8111
    API_KEY="$API_KEY_DEV"
    ENV_NAME="Development (Local)"
fi

echo "========================================"
echo "🏷️  Label Studio Launcher"
echo "========================================"
echo "Environment: $ENV_NAME"
echo "Port: $LABEL_STUDIO_PORT"
echo "Mode: $MODE"
echo "Dataset: $DATASET_DIR"
echo ""

# =============================================================================
# Web Server Mode (--web)
# =============================================================================

if [ "$USE_WEB_SERVER" = true ]; then

    if [ "$USE_PRODUCTION" = true ]; then
        # Production: proxy :8080 → Docker LS :8081
        PROXY_PORT=8080
        BACKEND_PORT=8081
        API_KEY="$API_KEY_PROD"

        echo "========================================"
        echo "  Reverse Proxy + Dataset Import (Prod)"
        echo "========================================"
        echo "  User-facing:   http://localhost:${PROXY_PORT}/  (proxy)"
        echo "  LS backend:    http://localhost:${BACKEND_PORT}/ (Docker)"
        echo ""

        # Ensure Label Studio Docker is running on backend port (8081)
        check_ls_backend() {
            curl -s "http://localhost:${BACKEND_PORT}/health" > /dev/null 2>&1
        }

        start_docker_backend() {
            echo "🧹 Cleaning up existing containers..."
            sudo docker rm -f ls 2>/dev/null || true
            sudo docker pull scruple/label-studio:latest
            echo "🚀 Starting Label Studio Docker on port ${BACKEND_PORT}..."
            sudo docker run -d \
                -u $(id -u):$(id -g) \
                --name ls \
                --env-file ls.env \
                -p 0.0.0.0:${BACKEND_PORT}:8080 \
                -v $(pwd)/mydata:/label-studio/data \
                -v ~/Videos/lerobot_storage:/home/gear/Videos/lerobot_storage \
                scruple/label-studio:latest \
                label-studio \
                --log-level DEBUG

            echo "⏳ Waiting for Label Studio to start..."
            until check_ls_backend; do
                sleep 1
            done
            echo "✓ Label Studio backend ready at http://localhost:${BACKEND_PORT}"
        }

        if check_ls_backend; then
            echo "✓ Label Studio backend already running at http://localhost:${BACKEND_PORT}"
            echo ""
            echo "What would you like to do?"
            echo "  1) Use existing Label Studio instance"
            echo "  2) Restart Label Studio (Docker)"
            echo ""
            read -p "Enter choice [1]: " choice
            choice=${choice:-1}

            case $choice in
                1)
                    echo "Using existing instance..."
                    ;;
                2)
                    start_docker_backend
                    ;;
                *)
                    echo "Invalid choice. Using existing instance..."
                    ;;
            esac
        else
            start_docker_backend
        fi
    else
        # Development: proxy :8110 → local LS :8111
        PROXY_PORT=8110
        BACKEND_PORT=8111
        API_KEY="$API_KEY_DEV"

        echo "========================================"
        echo "  Reverse Proxy + Dataset Import (Dev)"
        echo "========================================"
        echo "  User-facing:   http://localhost:${PROXY_PORT}/  (proxy)"
        echo "  LS backend:    http://localhost:${BACKEND_PORT}/ (local dev)"
        echo ""

        check_ls_backend() {
            curl -s "http://localhost:${BACKEND_PORT}/health" > /dev/null 2>&1
        }

        if check_ls_backend; then
            echo "✓ Label Studio dev server already running at http://localhost:${BACKEND_PORT}"
        else
            echo "⚠️  Label Studio is not running on port ${BACKEND_PORT}"
            echo "   Please start it manually in another terminal:"
            echo "   python label_studio/manage.py runserver 0.0.0.0:${BACKEND_PORT}"
            echo ""
            echo "⏳ Waiting for Label Studio to start..."
            until check_ls_backend; do
                sleep 2
            done
            echo "✓ Label Studio dev server ready at http://localhost:${BACKEND_PORT}"
        fi
    fi

    echo ""
    echo "🌐 Starting reverse proxy on port ${PROXY_PORT}..."
    echo "   Label Studio: http://localhost:${PROXY_PORT}/"
    echo "   Import:       http://localhost:${PROXY_PORT}/?dataset_dir=DATASET_NAME"
    echo "   Import UI:    http://localhost:${PROXY_PORT}/import"
    echo ""

    python dataset_server.py \
        --port ${PROXY_PORT} \
        --backend ${BACKEND_PORT} \
        --api-key "$API_KEY"

    exit 0
fi

# =============================================================================
# Check if Label Studio is running
# =============================================================================

check_label_studio() {
    curl -s "http://localhost:${LABEL_STUDIO_PORT}/health" > /dev/null 2>&1
}

start_docker_label_studio() {
    echo "🧹 Cleaning up existing containers..."
    sudo docker rm -f ls 2>/dev/null || true
    sudo docker pull scruple/label-studio:latest
    echo "🚀 Starting Label Studio (Docker)..."
    sudo docker run -d \
        -u $(id -u):$(id -g) \
        --name ls \
        --env-file ls.env \
        -p 0.0.0.0:${LABEL_STUDIO_PORT}:8080 \
        -v $(pwd)/mydata:/label-studio/data \
        -v ~/Videos/lerobot_storage:/home/gear/Videos/lerobot_storage \
        scruple/label-studio:latest \
        label-studio \
        --log-level DEBUG
    
    echo "⏳ Waiting for Label Studio to start..."
    until check_label_studio; do
        sleep 1
    done
    echo "✓ Label Studio is ready at http://localhost:${LABEL_STUDIO_PORT}"
}

if check_label_studio; then
    echo "✓ Label Studio is already running at http://localhost:${LABEL_STUDIO_PORT}"
    echo ""
    
    # Ask user what to do
    if [ "$USE_PRODUCTION" = true ]; then
        echo "What would you like to do?"
        echo "  1) Use existing Label Studio instance"
        echo "  2) Restart Label Studio (Docker)"
        echo ""
        read -p "Enter choice [1]: " choice
        choice=${choice:-1}
        
        case $choice in
            1)
                echo "Using existing instance..."
                ;;
            2)
                start_docker_label_studio
                ;;
            *)
                echo "Invalid choice. Using existing instance..."
                ;;
        esac
    else
        echo "Using existing development instance."
        echo "(Start manually with command in README.md)"
    fi
else
    echo "Label Studio is not running on port ${LABEL_STUDIO_PORT}"
    echo ""
    
    if [ "$USE_PRODUCTION" = true ]; then
        start_docker_label_studio
    else
        echo "⚠️  Development mode: Please start Label Studio manually:"
        echo "   cd label_studio && make run-dev"
        echo ""
        echo "⏳ Waiting for Label Studio to start..."
        until check_label_studio; do
            sleep 2
        done
        echo "✓ Label Studio is ready at http://localhost:${LABEL_STUDIO_PORT}"
    fi
fi

# =============================================================================
# Run mode-specific tasks
# =============================================================================

# Only run dataset processing if DATASET_DIR is provided
if [ -z "$DATASET_DIR" ]; then
    echo ""
    echo "✅ Docker setup complete! Open http://localhost:${LABEL_STUDIO_PORT}"
    echo "   (No dataset processing - dataset directory not specified)"
    exit 0
fi

if [ "$MODE" = "lerobot" ]; then
    # LeRobot mode - create tasks from S3/local videos
    echo ""
    echo "📹 LeRobot mode - Creating tasks from videos..."
    echo "   Dataset: $DATASET_DIR"
    echo ""
    
    python create_tasks.py \
        --dataset_dir "$DATASET_DIR" \
        --api_key "$API_KEY" \
        --base_url "http://localhost:${LABEL_STUDIO_PORT}"
        
    echo ""
    echo "✅ Done! Open http://localhost:${LABEL_STUDIO_PORT}"
    
elif [ "$MODE" = "packds" ]; then
    # PackDS mode - start frame server and create tasks with image sequences
    echo ""
    echo "📦 PackDS mode - Starting frame server..."
    echo "   Dataset (LanceDB): $DATASET_DIR"
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
        --dataset-dir "$DATASET_DIR" \
        --fps "$FPS" \
        --frame-server-port "$FRAME_SERVER_PORT" \
        $EXTRA_ARGS
fi
