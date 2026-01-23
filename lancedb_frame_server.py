"""
LanceDB Frame Server - 直接提供帧图片，无需转换成视频

为 Label Studio 提供图片序列，模拟视频播放体验。
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse, StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import lancedb
import tyro
from dataclasses import dataclass
from typing import Optional, List
import uvicorn
from io import BytesIO
import asyncio
import subprocess
import tempfile
import os
from pathlib import Path


@dataclass
class Config:
    """Frame server configuration."""
    
    lancedb_path: str
    """Path to LanceDB database."""
    
    table_name: str = "steps"
    """Table name in LanceDB."""
    
    port: int = 8000
    """Server port."""
    
    host: str = "0.0.0.0"
    """Server host."""
    
    view_columns: Optional[List[str]] = None
    """View column names. If None, auto-detect."""
    
    cache_size: int = 1000
    """Maximum number of frames to cache in memory."""
    
    video_cache_dir: Optional[str] = None
    """Directory to cache generated videos. If None, uses temp directory."""
    
    fps: float = 15.0
    """Frames per second for generated videos."""


class FrameServer:
    def __init__(self, config: Config):
        self.config = config
        print(f"📂 Connecting to LanceDB: {config.lancedb_path}")
        self.db = lancedb.connect(config.lancedb_path)
        self.table = self.db.open_table(config.table_name)
        
        # Auto-detect view columns
        sample = self.table.search().limit(1).to_list()
        if sample:
            if config.view_columns is None:
                self.view_columns = [
                    col for col in sample[0].keys() 
                    if col.startswith("video:")
                ]
            else:
                self.view_columns = config.view_columns
            
            # Create view name mapping
            self.view_map = {}
            for col in self.view_columns:
                view_name = col.replace("video:", "").replace("_processed", "")
                self.view_map[view_name] = col
            
            print(f"✓ Available views: {list(self.view_map.keys())}")
        else:
            raise ValueError("No data found in table")
        
        # Simple LRU cache for frames
        self._cache = {}
        self._cache_order = []
        
        # Video cache directory
        if config.video_cache_dir:
            self.video_cache_dir = Path(config.video_cache_dir)
            self.video_cache_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.video_cache_dir = Path(tempfile.gettempdir()) / "labelstudio_videos"
            self.video_cache_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"✓ Video cache directory: {self.video_cache_dir}")
    
    def get_frame(self, episode_idx: int, step_idx: int, view_name: str) -> bytes:
        """Get JPEG frame bytes."""
        cache_key = f"{episode_idx}_{step_idx}_{view_name}"
        
        # Check cache
        if cache_key in self._cache:
            return self._cache[cache_key]
        
        # Get column name
        if view_name not in self.view_map:
            raise ValueError(
                f"Unknown view: {view_name}. "
                f"Available: {list(self.view_map.keys())}"
            )
        
        col_name = self.view_map[view_name]
        
        # Query LanceDB
        query = f"episode_idx = {episode_idx} AND step_idx = {step_idx}"
        rows = self.table.search().where(query).limit(1).to_list()
        
        if not rows:
            raise ValueError(
                f"No frame found: episode={episode_idx}, step={step_idx}"
            )
        
        row = rows[0]
        if col_name not in row or row[col_name] is None:
            raise ValueError(f"View {view_name} not found in frame data")
        
        jpeg_bytes = row[col_name]
        
        # Handle different byte representations
        if isinstance(jpeg_bytes, dict):
            jpeg_bytes = jpeg_bytes.get('bytes', jpeg_bytes)
        
        # Cache with LRU eviction
        if len(self._cache) >= self.config.cache_size:
            oldest = self._cache_order.pop(0)
            del self._cache[oldest]
        
        self._cache[cache_key] = jpeg_bytes
        self._cache_order.append(cache_key)
        
        return jpeg_bytes
    
    def get_episode_info(self, episode_idx: Optional[int] = None) -> List[dict]:
        """Get information about episodes."""
        query = self.table.search()
        
        if episode_idx is not None:
            query = query.where(f"episode_idx = {episode_idx}")
        
        rows = query.to_list()
        
        # Group by episode
        episodes = {}
        for row in rows:
            ep_idx = row.get('episode_idx', 0)
            if ep_idx not in episodes:
                episodes[ep_idx] = {
                    'episode_idx': ep_idx,
                    'task_text': row.get('task_text', ''),
                    'frame_count': 0,
                    'min_step': float('inf'),
                    'max_step': 0,
                }
            
            step_idx = row.get('step_idx', 0)
            episodes[ep_idx]['frame_count'] += 1
            episodes[ep_idx]['min_step'] = min(
                episodes[ep_idx]['min_step'], step_idx
            )
            episodes[ep_idx]['max_step'] = max(
                episodes[ep_idx]['max_step'], step_idx
            )
        
        return list(episodes.values())
    
    def generate_video(self, episode_idx: int, view_name: str) -> Path:
        """
        Generate MP4 video from frame sequence using ffmpeg.
        Returns path to generated video file.
        """
        # Check if video already exists in cache
        video_filename = f"ep{episode_idx}_{view_name}.mp4"
        video_path = self.video_cache_dir / video_filename
        
        if video_path.exists():
            print(f"✓ Using cached video: {video_path}")
            return video_path
        
        print(f"🎬 Generating video: {video_filename}")
        
        # Get episode info
        episodes = self.get_episode_info(episode_idx)
        if not episodes:
            raise ValueError(f"Episode {episode_idx} not found")
        
        ep_info = episodes[0]
        
        # Create temporary directory for frames
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            
            # Save all frames to temp directory
            print(f"  Extracting {ep_info['frame_count']} frames...")
            for i, step in enumerate(range(ep_info['min_step'], ep_info['max_step'] + 1)):
                try:
                    jpeg_bytes = self.get_frame(episode_idx, step, view_name)
                    frame_path = temp_path / f"frame_{i:06d}.jpg"
                    frame_path.write_bytes(jpeg_bytes)
                except Exception as e:
                    print(f"  Warning: Failed to get frame {step}: {e}")
                    continue
            
            # Use ffmpeg to create video
            print(f"  Encoding video with ffmpeg...")
            cmd = [
                'ffmpeg',
                '-y',  # Overwrite output
                '-framerate', str(self.config.fps),
                '-i', str(temp_path / 'frame_%06d.jpg'),
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-preset', 'medium',
                '-crf', '23',
                str(video_path)
            ]
            
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    check=True
                )
                print(f"✓ Video generated: {video_path} ({video_path.stat().st_size / 1024 / 1024:.2f} MB)")
                return video_path
            except subprocess.CalledProcessError as e:
                print(f"❌ ffmpeg error: {e.stderr}")
                raise RuntimeError(f"Failed to generate video: {e.stderr}")
            except FileNotFoundError:
                raise RuntimeError(
                    "ffmpeg not found. Please install ffmpeg: "
                    "sudo apt-get install ffmpeg (Ubuntu) or brew install ffmpeg (Mac)"
                )


def create_app(config: Config) -> FastAPI:
    """Create FastAPI application."""
    
    app = FastAPI(
        title="LanceDB Frame Server",
        description="Serve frame sequences from LanceDB for Label Studio",
        version="2.0.0"
    )
    
    # CORS for Label Studio
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    server = FrameServer(config)
    
    @app.get("/")
    async def root():
        return {
            "service": "LanceDB Frame Server",
            "version": "3.0",
            "description": "On-demand video generation from frame sequences",
            "lancedb_path": config.lancedb_path,
            "available_views": list(server.view_map.keys()),
            "video_cache_dir": str(server.video_cache_dir),
            "fps": config.fps,
            "endpoints": {
                "frame": "/frame/{episode}/{step}/{view} - Get individual frame as JPEG",
                "video": "/video/{episode}/{view} - Get/generate MP4 video",
                "episodes": "/episodes - List available episodes",
                "tasks": "/tasks - Generate Label Studio tasks"
            }
        }
    
    @app.get("/frame/{episode_idx}/{step_idx}/{view_name}")
    async def get_frame(episode_idx: int, step_idx: int, view_name: str):
        """Get a single frame as JPEG."""
        try:
            jpeg_bytes = server.get_frame(episode_idx, step_idx, view_name)
            return Response(content=jpeg_bytes, media_type="image/jpeg")
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")
    
    @app.get("/episodes")
    async def list_episodes(episode_idx: Optional[int] = None):
        """List available episodes with metadata."""
        try:
            episodes = server.get_episode_info(episode_idx)
            return JSONResponse(content={
                "episodes": episodes,
                "count": len(episodes)
            })
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    
    @app.get("/tasks")
    async def generate_tasks(
        max_episodes: int = 100,
        episode_filter: Optional[int] = None,
        base_url: Optional[str] = None
    ):
        """Generate Label Studio tasks with virtual video URLs."""
        try:
            episodes = server.get_episode_info(episode_filter)
            episodes = sorted(episodes, key=lambda x: x['episode_idx'])[:max_episodes]
            
            if base_url is None:
                base_url = f"http://{config.host}:{config.port}"
            
            tasks = []
            for ep_info in episodes:
                ep_idx = ep_info['episode_idx']
                frame_count = ep_info['max_step'] - ep_info['min_step'] + 1
                
                task = {
                    'episode_idx': ep_idx,
                    'task_text': ep_info['task_text'],
                    'frame_count': frame_count,
                }
                
                # Generate single video URL for each view
                # These will be MP4 videos generated on-demand
                for view_name in server.view_map.keys():
                    task[view_name] = f"{base_url}/video/{ep_idx}/{view_name}"
                
                tasks.append(task)
            
            return JSONResponse(content={
                "tasks": tasks,
                "count": len(tasks)
            })
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    
    @app.get("/video/{episode_idx}/{view_name}")
    async def get_video(episode_idx: int, view_name: str):
        """
        Serve frame sequence as MP4 video file.
        Video is generated on-demand and cached for future requests.
        """
        try:
            # Generate or retrieve cached video
            video_path = server.generate_video(episode_idx, view_name)
            
            # Serve the video file
            return FileResponse(
                video_path,
                media_type="video/mp4",
                filename=f"episode_{episode_idx}_{view_name}.mp4"
            )
            
        except HTTPException:
            raise
        except Exception as e:
            print(f"Error serving video: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    
    @app.get("/health")
    async def health():
        return {"status": "healthy"}
    
    return app


def main():
    config = tyro.cli(Config)
    
    print("=" * 60)
    print("🚀 LanceDB Frame Server")
    print("   Zero-conversion solution for Label Studio")
    print("=" * 60)
    print()
    
    app = create_app(config)
    
    print()
    print("=" * 60)
    print(f"✓ Server starting on http://{config.host}:{config.port}")
    print("=" * 60)
    print()
    print("📝 Quick test:")
    print(f"   curl http://localhost:{config.port}/")
    print(f"   curl http://localhost:{config.port}/episodes")
    print(f"   curl http://localhost:{config.port}/tasks?max_episodes=5")
    print()
    print("Press Ctrl+C to stop")
    print()
    
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()

