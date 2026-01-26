#!/usr/bin/env python3
"""
LanceDB Frame Server for Label Studio Image Sequence Support.

Serves JPEG frames directly from LanceDB for use with Label Studio's
image sequence feature (packds format). This avoids converting frames
to video files, enabling faster loading.

Features:
- Direct JPEG serving from LanceDB
- Multi-view support (ego_view, left_wrist_view, right_wrist_view)
- All episodes imported as tasks
- CORS support for Label Studio
- Frame caching for performance

Usage:
    python frame_server.py --lancedb-path /path/to/db --api-key YOUR_KEY

    # Or via launch.sh:
    ./launch.sh --packds --lancedb-path /path/to/db
"""

import argparse
import os
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import Any, Dict, List, Optional

import lancedb
from label_studio_sdk import LabelStudio


# Default configuration
DEFAULT_LS_URL = os.environ.get("LABEL_STUDIO_URL", "http://localhost:8080")
DEFAULT_LANCEDB_PATH = os.environ.get("LANCEDB_PATH", "/home/gear/lerobot_lancedb")
DEFAULT_TABLE_NAME = "steps"
DEFAULT_FRAME_SERVER_PORT = 8765
DEFAULT_FPS = 15.0


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTP server that handles each request in a separate thread."""

    daemon_threads = True  # Don't wait for threads on shutdown


def create_label_config(fps: float) -> str:
    """Generate Label Studio config for multi-view image sequence annotation."""
    return f"""
<View>
    <Style>
        .video-row {{
            display: flex;
            flex-wrap: nowrap;
            gap: 1em;
            width: 100%;
        }}
        
        .video-item {{
            flex: 1;
            min-width: 0;
        }}
        
        .timeline-container {{
            width: 100% !important;
            margin-top: 1em;
        }}
        
        .timeline-container .video-segmentation {{
            width: 100% !important;
        }}
        
        .timeline-container .video-segmentation__timeline {{
            width: 100% !important;
        }}
        
        .timeline-container .video-segmentation__main {{
            display: none !important;
        }}
        
        .meta-info {{
            background: #f5f5f5;
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            font-family: monospace;
        }}
    </Style>
    
    <View className="meta-info">
        <Text name="meta" value="Episode: $episode_idx | Task: $task_text"/>
    </View>
    
    <View className="video-row">
        <View className="video-item">
            <Header value="Left Wrist View"/>
            <Video name="left_wrist_view"
                frameSequence="$left_wrist_view"
                sync="ego_view"
                frameRate="{fps}"
                height="400"/>
        </View>

        <View className="video-item">
            <Header value="Ego View (Display)"/>
            <Video name="ego_view_display"
                frameSequence="$ego_view"
                sync="ego_view"
                frameRate="{fps}"
                height="400"/>
        </View>

        <View className="video-item">
            <Header value="Right Wrist View"/>
            <Video name="right_wrist_view"
                frameSequence="$right_wrist_view"
                sync="ego_view"
                frameRate="{fps}"
                height="400"/>
        </View>
    </View>

    <View className="timeline-container">
        <Video name="ego_view"
            frameSequence="$ego_view"
            sync="ego_view"
            frameRate="{fps}"
            timelineHeight="250"
            height="1"/>
        
        <VideoRectangle name="box"
                        toName="ego_view"
                        perFrame="true"/>
        
        <Labels name="videoLabels"
                toName="ego_view">
            <Label value="Subgoal"    background="#944BFF"/>
            <Label value="Suboptimal" background="#FFA500"/>
            <Label value="Failure"    background="#FF0000"/>
            <Label value="Success"    background="#00FF00"/>
        </Labels>
        
        <TextArea name="notes"
                  toName="ego_view"
                  placeholder="Additional notes..."
                  rows="3"/>
    </View>
</View>
"""


class FrameCache:
    """Thread-safe LRU cache for frame data."""

    def __init__(self, max_size: int = 1000):
        self.max_size = max_size
        self.cache: Dict[str, bytes] = {}
        self.order: List[str] = []
        self.lock = threading.Lock()

    def get(self, key: str) -> Optional[bytes]:
        with self.lock:
            return self.cache.get(key)

    def put(self, key: str, value: bytes) -> None:
        with self.lock:
            if key in self.cache:
                return
            if len(self.cache) >= self.max_size:
                oldest = self.order.pop(0)
                del self.cache[oldest]
            self.cache[key] = value
            self.order.append(key)


class LanceDBFrameHandler(BaseHTTPRequestHandler):
    """HTTP handler that serves frames from LanceDB."""

    # Class-level state (shared across requests)
    table: Any = None
    view_map: Dict[str, str] = {}
    cache: FrameCache = FrameCache()

    def log_message(self, format: str, *args: Any) -> None:
        """Suppress default request logging."""
        pass

    def do_GET(self) -> None:
        """
        Handle GET request for frame.

        URL format: /frame/{episode_idx}/{step_idx}/{view_name}
        """
        try:
            parts = self.path.strip("/").split("/")

            # Health check
            if parts[0] == "health":
                self._send_json({"status": "ok", "views": list(self.view_map.keys())})
                return

            # Frame request
            if len(parts) != 4 or parts[0] != "frame":
                self.send_error(404, "Use /frame/{episode}/{step}/{view}")
                return

            _, episode_idx, step_idx, view_name = parts
            episode_idx = int(episode_idx)
            step_idx = int(step_idx)

            # Get frame from cache or LanceDB
            jpeg_bytes = self._get_frame(episode_idx, step_idx, view_name)

            if jpeg_bytes is None:
                self.send_error(
                    404,
                    f"Frame not found: ep={episode_idx}, step={step_idx}, view={view_name}",
                )
                return

            # Send JPEG response
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg_bytes)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(jpeg_bytes)

        except BrokenPipeError:
            # Client disconnected, ignore
            pass
        except ConnectionResetError:
            # Client reset connection, ignore
            pass
        except Exception as e:
            try:
                self.send_error(500, str(e))
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight requests."""
        try:
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, data: dict) -> None:
        """Send JSON response."""
        import json

        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _get_frame(self, episode_idx: int, step_idx: int, view_name: str) -> Optional[bytes]:
        """Get frame bytes from cache or LanceDB."""
        if self.table is None:
            return None

        # Check cache first
        cache_key = f"{episode_idx}_{step_idx}_{view_name}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached

        # Get column name from view map
        col_name = self.view_map.get(view_name)
        if col_name is None:
            print(f"View '{view_name}' not found. Available: {list(self.view_map.keys())}")
            return None

        # Query LanceDB
        query = f"episode_idx = {episode_idx} AND step_idx = {step_idx}"
        rows = self.table.search().where(query).limit(1).to_list()

        if not rows:
            return None

        jpeg_bytes = rows[0].get(col_name)
        if jpeg_bytes is None:
            return None

        # Handle pyarrow binary format
        if isinstance(jpeg_bytes, dict):
            jpeg_bytes = jpeg_bytes.get("bytes", jpeg_bytes)

        # Cache and return
        self.cache.put(cache_key, jpeg_bytes)
        return jpeg_bytes


def col_to_view_name(col_name: str) -> str:
    """Convert LanceDB column name to view name."""
    # video:observation.images.top_head_processed -> ego_view
    # video:observation.images.left_wrist_processed -> left_wrist_view
    # video:observation.images.right_wrist_processed -> right_wrist_view
    name = col_name.lower()
    if "top" in name or "head" in name or "ego" in name:
        if "right" in name:
            return "right_ego_view"
        return "ego_view"
    elif "left" in name:
        return "left_wrist_view"
    elif "right" in name:
        return "right_wrist_view"
    else:
        # Fallback: use column name without prefix
        return col_name.replace("video:", "").replace("_processed", "").replace(".", "_")


def start_frame_server(
    lancedb_path: str,
    table_name: str,
    port: int = DEFAULT_FRAME_SERVER_PORT,
) -> tuple:
    """
    Start HTTP server for serving LanceDB frames.

    Args:
        lancedb_path: Path to LanceDB database
        table_name: Table name in LanceDB
        port: Server port

    Returns:
        Tuple of (HTTPServer, view_map dict)
    """
    print(f"📂 Connecting to LanceDB: {lancedb_path}")
    db = lancedb.connect(lancedb_path)
    table = db.open_table(table_name)

    # Auto-detect view columns (columns starting with "video:")
    sample = table.search().limit(1).to_list()
    if not sample:
        raise ValueError("No data in table")

    # Build view name -> column name mapping
    view_map = {}
    for col in sample[0].keys():
        if col.startswith("video:"):
            view_name = col_to_view_name(col)
            view_map[view_name] = col

    print(f"✓ Available views: {list(view_map.keys())}")
    for view_name, col_name in view_map.items():
        print(f"   {view_name} -> {col_name}")

    # Configure handler class
    LanceDBFrameHandler.table = table
    LanceDBFrameHandler.view_map = view_map
    LanceDBFrameHandler.cache = FrameCache()

    # Start threaded server for concurrent requests (important for multi-view)
    server = ThreadedHTTPServer(("0.0.0.0", port), LanceDBFrameHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    print(f"✓ Frame server running on http://localhost:{port} (threaded)")
    return server, view_map


def get_all_episodes(
    lancedb_path: str,
    table_name: str,
    max_episodes: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Get all episodes metadata from LanceDB.

    Args:
        lancedb_path: Path to LanceDB database
        table_name: Table name
        max_episodes: Maximum number of episodes to return (None = all)

    Returns:
        List of episode info dicts
    """
    db = lancedb.connect(lancedb_path)
    table = db.open_table(table_name)

    # Get all rows
    rows = table.search().to_list()

    if not rows:
        raise ValueError("No data found in table")

    # Group by episode
    episodes: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        ep_idx = row.get("episode_idx", 0)
        step_idx = row.get("step_idx", 0)

        if ep_idx not in episodes:
            episodes[ep_idx] = {
                "episode_idx": ep_idx,
                "task_text": row.get("task_text", ""),
                "min_step": step_idx,
                "max_step": step_idx,
                "frame_count": 0,
            }

        episodes[ep_idx]["min_step"] = min(episodes[ep_idx]["min_step"], step_idx)
        episodes[ep_idx]["max_step"] = max(episodes[ep_idx]["max_step"], step_idx)
        episodes[ep_idx]["frame_count"] += 1

    # Sort by episode index
    result = sorted(episodes.values(), key=lambda x: x["episode_idx"])

    if max_episodes is not None:
        result = result[:max_episodes]

    return result


def create_tasks_for_all_episodes(
    client: LabelStudio,
    frame_server_url: str,
    episodes: List[Dict[str, Any]],
    view_map: Dict[str, str],
    fps: float,
) -> int:
    """
    Create Label Studio project and tasks for all episodes.

    Returns:
        Project ID
    """
    # Create project
    project_name = f"LanceDB Image Sequences ({len(episodes)} episodes)"
    print(f"\n📝 Creating project: {project_name}")

    label_config = create_label_config(fps)
    project = client.projects.create(
        title=project_name,
        label_config=label_config,
    )
    print(f"✓ Created project (ID: {project.id})")

    # Build tasks for all episodes
    tasks = []
    for ep_info in episodes:
        ep_idx = ep_info["episode_idx"]

        task_data = {
            "episode_idx": ep_idx,
            "task_text": ep_info["task_text"],
        }

        # Add frame URLs for each view
        for view_name in view_map.keys():
            frame_urls = [
                f"{frame_server_url}/frame/{ep_idx}/{step}/{view_name}"
                for step in range(ep_info["min_step"], ep_info["max_step"] + 1)
            ]
            task_data[view_name] = frame_urls

        tasks.append(task_data)

    # Import all tasks
    print(f"📥 Creating {len(tasks)} tasks...")
    result = client.projects.import_tasks(
        id=project.id,
        request=tasks,
    )
    print(f"✓ Created {result.task_count} task(s)")

    return project.id


def main() -> int:
    parser = argparse.ArgumentParser(
        description="LanceDB Frame Server for Label Studio",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("LABEL_STUDIO_API_KEY"),
        help="Label Studio API key (or set LABEL_STUDIO_API_KEY env var)",
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_LS_URL,
        help="Label Studio URL",
    )
    parser.add_argument(
        "--lancedb-path",
        default=DEFAULT_LANCEDB_PATH,
        help="Path to LanceDB database",
    )
    parser.add_argument(
        "--table-name",
        default=DEFAULT_TABLE_NAME,
        help="LanceDB table name",
    )
    parser.add_argument(
        "--max-episodes",
        type=int,
        default=None,
        help="Maximum number of episodes to import (default: all)",
    )
    parser.add_argument(
        "--frame-server-port",
        type=int,
        default=DEFAULT_FRAME_SERVER_PORT,
        help="Port for frame server",
    )
    parser.add_argument(
        "--fps",
        type=float,
        default=DEFAULT_FPS,
        help="Frame rate for playback",
    )
    args = parser.parse_args()

    if not args.api_key:
        print("Error: API key required.")
        print("  Use --api-key YOUR_KEY or set LABEL_STUDIO_API_KEY env var")
        print("  Get your key from Label Studio > Account & Settings > Access Token")
        return 1

    base_url = args.base_url.rstrip("/")
    frame_server_url = f"http://localhost:{args.frame_server_port}"

    try:
        # Start frame server
        print("\n" + "=" * 60)
        print("🚀 LanceDB Frame Server")
        print("=" * 60)

        server, view_map = start_frame_server(
            args.lancedb_path,
            args.table_name,
            args.frame_server_port,
        )

        # Get all episodes
        print(f"\n📊 Loading episodes from LanceDB...")
        episodes = get_all_episodes(
            args.lancedb_path,
            args.table_name,
            args.max_episodes,
        )

        total_frames = sum(ep["frame_count"] for ep in episodes)
        print(f"✓ Found {len(episodes)} episodes, {total_frames} total frames")

        # Show sample episodes
        for ep in episodes[:3]:
            print(f"   Episode {ep['episode_idx']}: {ep['frame_count']} frames - {ep['task_text'][:50]}...")
        if len(episodes) > 3:
            print(f"   ... and {len(episodes) - 3} more episodes")

        # Connect to Label Studio
        print(f"\n📡 Connecting to Label Studio: {base_url}")
        client = LabelStudio(base_url=base_url, api_key=args.api_key)

        user_info = client.users.whoami()
        print(f"✓ Authenticated as: {getattr(user_info, 'email', 'User')}")

        # Create project and tasks
        project_id = create_tasks_for_all_episodes(
            client,
            frame_server_url,
            episodes,
            view_map,
            args.fps,
        )

        # Print success message
        project_url = f"{base_url}/projects/{project_id}/"
        print(f"\n{'=' * 60}")
        print("✅ SUCCESS!")
        print(f"\n🌐 Open Label Studio: {project_url}")
        print(f"\n📊 Statistics:")
        print(f"   • {len(episodes)} episodes")
        print(f"   • {total_frames} total frames")
        print(f"   • {len(view_map)} views: {', '.join(view_map.keys())}")
        print(f"   • {args.fps} fps playback")
        print(f"\n⚠️  Keep this script running! (Frame server: {frame_server_url})")
        print(f"{'=' * 60}")

        # Keep running until Ctrl+C
        print("\nPress Ctrl+C to stop...")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n\n🛑 Shutting down...")
            server.shutdown()

        return 0

    except Exception as e:
        import traceback

        print(f"\n❌ Error: {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit(main())
