#!/usr/bin/env python3
"""
Minimal test script to verify JPEG image sequence support in Label Studio.

This script:
1. Creates a simple project with image sequence labeling config
2. Creates a task with frame URLs
3. Prints the URL to open in browser for testing

Prerequisites:
- Label Studio running on localhost:8111
- Valid API key (get from Account & Settings)
- label_studio_sdk installed: pip install label-studio-sdk

Usage:
    python test_image_sequence.py --api-key YOUR_API_KEY

Or set environment variable:
    export LABEL_STUDIO_API_KEY=YOUR_API_KEY
    python test_image_sequence.py
"""

import argparse
import os

from label_studio_sdk import LabelStudio

# Configuration
DEFAULT_URL = os.environ.get("LABEL_STUDIO_URL", "http://localhost:8111")

# Sample frame URLs - using placeholder images for testing
# Replace with your actual JPEG sequence URLs
SAMPLE_FRAMES = [
    f"https://picsum.photos/seed/{i}/640/480"
    for i in range(1, 31)  # 30 frames
]

# Labeling config with image sequence support
LABELING_CONFIG = """
<View>
  <Header value="Image Sequence (packds format) Test"/>
  <Video name="video" frameSequence="$frames" frameRate="10" height="500"/>
  <VideoRectangle name="box" toName="video"/>
  <Labels name="label" toName="video">
    <Label value="Person" background="red"/>
    <Label value="Car" background="blue"/>
    <Label value="Object" background="green"/>
  </Labels>
</View>
"""

# Alternative: Pattern-based config
LABELING_CONFIG_PATTERN = """
<View>
  <Header value="Image Sequence (Pattern-based) Test"/>
  <Video 
    name="video" 
    frameSequence='{"type": "pattern", "pattern": "$baseUrl/{frame}.jpg", "totalFrames": "$totalFrames", "padWidth": 4}' 
    frameRate="10" 
    height="500"
  />
  <VideoRectangle name="box" toName="video"/>
  <Labels name="label" toName="video">
    <Label value="Person" background="red"/>
    <Label value="Car" background="blue"/>
  </Labels>
</View>
"""


def main():
    parser = argparse.ArgumentParser(description="Test image sequence support in Label Studio")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("LABEL_STUDIO_API_KEY"),
        help="Label Studio API key (or set LABEL_STUDIO_API_KEY env var)",
    )
    parser.add_argument(
        "--pattern",
        action="store_true",
        help="Use pattern-based config instead of array",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_URL,
        help=f"Label Studio URL (default: {DEFAULT_URL})",
    )
    args = parser.parse_args()

    if not args.api_key:
        print("Error: API key required. Use --api-key or set LABEL_STUDIO_API_KEY")
        print("\nTo get your API key:")
        print("1. Open Label Studio in browser")
        print("2. Go to Account & Settings")
        print("3. Copy your Access Token")
        return 1

    base_url = args.base_url.rstrip("/")

    print(f"📡 Connecting to Label Studio: {base_url}")

    try:
        # Connect using SDK
        client = LabelStudio(base_url=base_url, api_key=args.api_key)

        # Verify connection
        user_info = client.users.whoami()
        email = getattr(user_info, "email", "User")
        print(f"✓ Authenticated as: {email}")

        # Create project
        config = LABELING_CONFIG_PATTERN if args.pattern else LABELING_CONFIG
        project_name = "Image Sequence Test (Pattern)" if args.pattern else "Image Sequence Test (Array)"

        print(f"\n📝 Creating project: {project_name}")
        project = client.projects.create(
            title=project_name,
            label_config=config,
        )
        print(f"✓ Created project (ID: {project.id})")

        # Create task
        if args.pattern:
            # Pattern-based task data
            task_data = {
                "baseUrl": "https://picsum.photos/seed",
                "totalFrames": 30,
            }
        else:
            # Array-based task data
            task_data = {
                "frames": SAMPLE_FRAMES,
            }

        print("📥 Creating task...")
        result = client.projects.import_tasks(
            id=project.id,
            request=[task_data],
        )
        print(f"✓ Created {result.task_count} task(s)")

        # Get the task ID by listing tasks
        tasks = client.tasks.list(project=project.id)
        task_id = tasks[0].id if tasks else None

        # Print URL to test
        labeling_url = f"{base_url}/projects/{project.id}/data?task={task_id}"
        print(f"\n{'=' * 60}")
        print("SUCCESS! Open this URL to test image sequence annotation:")
        print(f"\n  {labeling_url}\n")
        print("Expected behavior:")
        print("  - Video player should load showing JPEG frames")
        print("  - Play/pause should work (frames advance at 10fps)")
        print("  - Timeline scrubbing should work")
        print("  - VideoRectangle drawing should work")
        print("  - Frame stepping (arrow keys) should work")
        print(f"{'=' * 60}")

        return 0

    except Exception as e:
        print(f"Error: {e}")
        if "Connection" in str(e):
            print(f"\nMake sure Label Studio is running at {base_url}")
        return 1


if __name__ == "__main__":
    exit(main())
