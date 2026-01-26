#!/bin/bash
# Quick Docker Build and Push (No prompts)
# Usage: bash quick_build_push.sh

set -e

IMAGE_NAME="scruple/label-studio"
DATE_TAG=$(date +%Y%m%d)

echo "🚀 Building and pushing $IMAGE_NAME..."

# Build
docker build -t ${IMAGE_NAME}:latest -t ${IMAGE_NAME}:${DATE_TAG} . && \

# Push
docker push ${IMAGE_NAME}:latest && \
docker push ${IMAGE_NAME}:${DATE_TAG} && \

echo "✅ Done! Images published:"
echo "   - ${IMAGE_NAME}:latest"
echo "   - ${IMAGE_NAME}:${DATE_TAG}"


