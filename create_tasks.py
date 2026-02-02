"""
Task creation script for Label Studio.

Import video files from local or S3 storage (LeRobot format).
"""

from label_studio_sdk import LabelStudio
import tyro
from dataclasses import dataclass
from typing import Optional, Dict, Any
import os
import json
import boto3
from botocore.exceptions import BotoCoreError, ClientError
import re


@dataclass
class Config:
    """Configuration for creating Label Studio tasks."""

    api_key: str = None
    """Label Studio API token. Create one in Account & Settings → Access Tokens."""

    base_url: str = "http://localhost:8080/"
    """Label Studio URL."""

    project_id: int = -1
    """Existing project ID, or -1 to create new."""

    project_name: Optional[str] = None
    """Project name (for new projects)."""

    dataset_dir: Optional[str] = None
    """Root directory with videos (local path or s3://bucket/prefix)."""

    storage_name: Optional[str] = None
    """Name for storage connection."""

    fps: float = 30.0
    """Frame rate for video playback."""


def create_label_config(fps: float = 30.0) -> str:
    """Generate Label Studio config for multi-view video annotation."""
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
                value="$left_wrist_view"
                sync="ego_view"
                framerate="{fps}"
                height="400"/>
        </View>

        <View className="video-item">
            <Header value="Ego View (Display)"/>
            <Video name="ego_view_display"
                value="$ego_view"
                sync="ego_view"
                framerate="{fps}"
                height="400"/>
        </View>

        <View className="video-item">
            <Header value="Right Wrist View"/>
            <Video name="right_wrist_view"
                value="$right_wrist_view"
                sync="ego_view"
                framerate="{fps}"
                height="400"/>
        </View>
    </View>

    <View className="timeline-container">
        <Video name="ego_view"
            value="$ego_view"
            sync="ego_view"
            framerate="{fps}"
            timelineHeight="250"
            height="1"
            resolver='[
                {{"value": "object adjustment", "label": "不完美：位置调整", "whenLabelValue": "suboptimal"}},
                {{"value": "passive deviation", "label": "不完美：被动偏离", "whenLabelValue": "suboptimal"}},
                {{"value": "object dropped", "label": "失败：物体掉落", "whenLabelValue": "failure"}},
                {{"value": "placement failure", "label": "失败：放置错误", "whenLabelValue": "failure"}},
                {{"value": "minor keyframes", "label": "产生小进展的关键帧", "whenLabelValue": "subgoal"}},
                {{"value": "major keyframes", "label": "产生巨大进展的关键帧", "whenLabelValue": "subgoal"}}
            ]'/>
        
        <VideoRectangle name="box"
                        toName="ego_view"
                        perFrame="true"/>
        
        <Labels name="videoLabels"
                toName="ego_view">
            <Label value="subgoal"    background="#944BFF"/>
            <Label value="suboptimal" background="#FFA500"/>
            <Label value="failure"    background="#FF0000"/>
        </Labels>
        
        <TextArea name="notes"
                  toName="ego_view"
                  placeholder="Additional notes..."
                  rows="3"/>
    </View>
</View>
"""


def load_episodes_metadata(dataset_dir: str) -> Dict[int, Dict[str, Any]]:
    """
    Load episode metadata from meta/episodes.jsonl file.

    Args:
        dataset_dir: Root directory of LeRobot dataset (local path or s3://)

    Returns:
        Dictionary mapping episode_index to episode metadata (including trajectory_id)
    """
    episodes_map = {}

    if dataset_dir.startswith("s3://"):
        # S3: download and parse episodes.jsonl
        bucket, prefix = dataset_dir.replace("s3://", "").split("/", 1)
        prefix = prefix.rstrip("/")
        episodes_key = f"{prefix}/meta/episodes.jsonl"

        try:
            s3 = boto3.client("s3")
            response = s3.get_object(Bucket=bucket, Key=episodes_key)
            content = response["Body"].read().decode("utf-8")

            for line in content.strip().split("\n"):
                if line.strip():
                    episode = json.loads(line)
                    ep_idx = episode.get("episode_index", 0)
                    episodes_map[ep_idx] = episode

            print(f"✓ Loaded {len(episodes_map)} episodes from s3://{bucket}/{episodes_key}")
        except Exception as e:
            print(f"⚠️  Could not load episodes.jsonl from S3: {e}")
    else:
        # Local: read episodes.jsonl directly
        episodes_path = os.path.join(dataset_dir, "meta", "episodes.jsonl")

        if os.path.exists(episodes_path):
            try:
                with open(episodes_path, "r") as f:
                    for line in f:
                        if line.strip():
                            episode = json.loads(line)
                            ep_idx = episode.get("episode_index", 0)
                            episodes_map[ep_idx] = episode

                print(f"✓ Loaded {len(episodes_map)} episodes from {episodes_path}")
            except Exception as e:
                print(f"⚠️  Could not load episodes.jsonl: {e}")
        else:
            print(f"⚠️  episodes.jsonl not found at {episodes_path}")

    return episodes_map


def name2key(view_name: str, view_dirname: str) -> str:
    """Map view directory name to canonical view key."""
    if ("ego" in view_name or "top" in view_name or "head" in view_name) and "right" not in view_name:
        return "ego_view"
    elif ("ego" in view_name or "top" in view_name or "head" in view_name) and "right" in view_name:
        return "right_ego_view"
    elif "left" in view_name:
        return "left_wrist_view"
    elif "right" in view_name:
        return "right_wrist_view"
    else:
        raise ValueError(f"Unknown view name: {view_name} (from dir {view_dirname})")


def build_s3_tasks_map(bucket: str, prefix: str = "") -> dict:
    """
    Traverse s3://bucket/prefix/*.mp4 files and build tasks map.

    Returns:
        {
            "chunk/filename.mp4": {
                "ego_view": "s3://bucket/path/ego.mp4",
                "left_wrist_view": "s3://bucket/path/left_wrist.mp4",
                ...
            },
            ...
        }
    """
    s3 = boto3.resource("s3")
    tasks_map = {}

    if prefix and not prefix.endswith("/"):
        prefix += "/"

    try:
        bucket_obj = s3.Bucket(bucket)
        for obj in bucket_obj.objects.filter(Prefix=prefix):
            key = obj.key
            if not key.lower().endswith(".mp4"):
                continue

            rel_key = key[len(prefix) :].lstrip("/")
            parts = rel_key.split("/")
            if len(parts) < 2:
                continue

            video_filename = parts[-1]
            view_dirname = parts[-2]
            view_name = view_dirname.split(".")[-1]

            view_key = name2key(view_name, view_dirname)
            chunk = parts[0]
            group_key = f"{chunk}/{video_filename}"
            s3_path = f"s3://{bucket}/{key}"

            tasks_map.setdefault(group_key, {})[view_key] = s3_path

    except (BotoCoreError, ClientError) as e:
        print(f"❌ AWS call failed: {e}")
        raise

    return tasks_map


def import_lerobot_tasks(cfg: Config, client: LabelStudio, project) -> int:
    """Import tasks from video files (local or S3) - LeRobot dataset format."""

    print("=" * 60)
    print("🤖 LEROBOT MODE: Importing video files")
    print("=" * 60)
    print()

    if not cfg.dataset_dir:
        raise ValueError("dataset_dir is required for lerobot mode")

    tasks_map = {}

    if cfg.storage_name is None:
        title = f"Import Storage {cfg.dataset_dir}"
    else:
        title = f"Import Storage {cfg.storage_name}"

    # S3 storage
    if cfg.dataset_dir.startswith("s3://"):
        bucket, prefix = cfg.dataset_dir.replace("s3://", "").split("/", 1)
        prefix = prefix.rstrip("/") + "/videos/"

        # Check for existing storage
        for st in client.import_storage.s3.list(project=project.id):
            if st.title == title:
                print(f"✓ Reusing existing S3 import storage: {title}")
                tasks_map = build_s3_tasks_map(bucket=bucket, prefix=prefix)
                break
        else:
            # Create new S3 storage
            client.import_storage.s3.create(
                project=project.id,
                recursive_scan=True,
                regex_filter=r".*\.(mp4|avi|mov|wmv|webm)$",
                aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
                aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
                bucket=bucket,
                prefix=prefix,
                presign=True,
                region_name="us-east-1",
                s3endpoint=os.environ["S3_ENDPOINT_URL"],
                title=title,
                use_blob_urls=True,
            )
            tasks_map = build_s3_tasks_map(bucket=bucket, prefix=prefix)
            print(f"✓ Created S3 import storage: {title} -> s3://{bucket}/{prefix}")

    # Local storage
    else:
        local_path = os.path.join(cfg.dataset_dir, "videos")

        # Check for existing storage
        for st in client.import_storage.local.list(project=project.id):
            if st.title == title:
                print(f"✓ Reusing existing local import storage: {title}")
                break
        else:
            # Create new local storage
            client.import_storage.local.create(
                path=local_path,
                project=project.id,
                regex_filter=r".*\.(mp4|avi|mov|wmv|webm)$",
                title=title,
                use_blob_urls=True,
            )
            print(f"✓ Created local import storage: {title} -> {local_path}")

        # Build tasks map
        for root, _, files in os.walk(local_path):
            for video_filename in files:
                if not video_filename.endswith(".mp4"):
                    continue

                video_path = os.path.join(root, video_filename)
                view_dirname = os.path.basename(root)
                view_name = view_dirname.split(".")[-1]
                view_key = name2key(view_name, view_dirname)

                rel = os.path.relpath(video_path, local_path)
                parts = rel.split(os.sep)
                chunk = parts[0] if parts else ""
                group_key = f"{chunk}/{video_filename}"

                abs_path = os.path.abspath(video_path)
                rel_path = abs_path.lstrip("/home/gear/Videos/lerobot_storage/")
                tasks_map.setdefault(group_key, {})[view_key] = f"/data/local-files/?d={rel_path}"

    # Load episode metadata from meta/episodes.jsonl
    episodes_metadata = load_episodes_metadata(cfg.dataset_dir)

    # Import tasks and add metadata
    tasks_json = []
    for idx, (group_key, task_data) in enumerate(tasks_map.items()):
        # Extract episode number from group_key or filename
        episode_match = re.search(r"episode[_-](\d+)", group_key, re.IGNORECASE)
        if episode_match:
            episode_idx = int(episode_match.group(1))
        else:
            episode_idx = idx

        # Add metadata fields required by label config
        task_data["episode_idx"] = episode_idx
        task_data["task_text"] = group_key.split("/")[0] if "/" in group_key else "N/A"

        # Add trajectory_id from episodes.jsonl metadata
        if episode_idx in episodes_metadata:
            ep_meta = episodes_metadata[episode_idx]
            if "trajectory_id" in ep_meta:
                task_data["trajectory_id"] = ep_meta["trajectory_id"]
            # Optionally include other metadata from episodes.jsonl
            if "tasks" in ep_meta and ep_meta["tasks"]:
                task_data["task_text"] = (
                    ep_meta["tasks"][0] if isinstance(ep_meta["tasks"], list) else ep_meta["tasks"]
                )

        tasks_json.append(task_data)

    print()
    print(f"📥 Importing {len(tasks_json)} tasks...")

    result = client.projects.import_tasks(
        request=tasks_json,
        id=project.id,
        return_task_ids=True,
    )

    print(f"✓ Successfully imported {result.task_count} tasks")
    return result.task_count


def ensure_export_storage(cfg: Config, client: LabelStudio, project_id: int):
    """Create or reuse export storage connection."""

    print()
    print("💾 Setting up export storage...")

    if not cfg.dataset_dir:
        print("⚠️  No dataset_dir specified, skipping export storage")
        return None

    if cfg.storage_name is None:
        title = f"Export Storage {cfg.dataset_dir}"
    else:
        title = f"Export Storage {cfg.storage_name}"

    # S3 export
    if cfg.dataset_dir.startswith("s3://"):
        bucket, prefix = cfg.dataset_dir.replace("s3://", "").split("/", 1)
        prefix = prefix.rstrip("/") + "/annotations"

        for st in client.export_storage.s3.list(project=project_id):
            if st.title == title:
                print("✓ Reusing existing S3 export storage")
                return st

        st = client.export_storage.s3.create(
            project=project_id,
            bucket=bucket,
            prefix=prefix,
            aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
            region_name="us-east-1",
            s3endpoint=os.environ.get("S3_ENDPOINT_URL", None),
            title=title,
            can_delete_objects=False,
        )
        print(f"✓ Created S3 export storage: s3://{bucket}/{prefix}")

    # Local export
    else:
        local_path = os.path.join(cfg.dataset_dir, "annotations")
        os.makedirs(local_path, exist_ok=True)

        for st in client.export_storage.local.list(project=project_id):
            if st.title == title:
                print("✓ Reusing existing local export storage")
                return st

        st = client.export_storage.local.create(
            project=project_id,
            path=local_path,
            title=title,
            use_blob_urls=False,
        )
        print(f"✓ Created local export storage: {local_path}")

    return st


def main():
    cfg = tyro.cli(Config)

    print("=" * 60)
    print("🏷️  Label Studio Task Creator")
    print("=" * 60)
    print()

    # Validate configuration
    if not cfg.dataset_dir:
        raise ValueError("dataset_dir is required")
    if not cfg.api_key:
        raise ValueError("api_key is required")

    # Connect to Label Studio
    print(f"📡 Connecting to Label Studio: {cfg.base_url}")
    client = LabelStudio(base_url=cfg.base_url, api_key=cfg.api_key)

    user_info = client.users.whoami()
    email = user_info.email if hasattr(user_info, "email") else "User"
    print(f"✓ Authenticated as: {email}")
    print()

    # Create or get project
    if cfg.project_id == -1:
        print("📝 Creating new project...")
        label_config = create_label_config(cfg.fps)

        project_name = cfg.project_name or cfg.dataset_dir.rstrip("/").split("/")[-1][:50]
        project = client.projects.create(title=project_name, label_config=label_config)
        print(f"✓ Created project: {project.title} (ID: {project.id})")
    else:
        print(f"📂 Using existing project {cfg.project_id}...")
        project = client.projects.get(id=cfg.project_id)
        print(f"✓ Project: {project.title}")

    print()

    # Import tasks
    task_count = import_lerobot_tasks(cfg, client, project)

    # Setup export storage
    try:
        ensure_export_storage(cfg, client, project.id)
    except Exception as e:
        print(f"⚠️  Could not setup export storage: {e}")

    print()
    print("=" * 60)
    print("✅ All done!")
    print("=" * 60)
    print()
    print("🌐 Access your project:")
    print(f"   {cfg.base_url}/projects/{project.id}/")
    print()
    print("📊 Statistics:")
    print(f"   - Total tasks: {task_count}")
    print()


if __name__ == "__main__":
    main()
