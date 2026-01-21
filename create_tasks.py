from label_studio_sdk import LabelStudio
import tyro
from dataclasses import dataclass
import os
import boto3
from botocore.exceptions import BotoCoreError, ClientError
import subprocess


@dataclass
class Config:
    """Configuration for creating a Label-Studio project and importing multi-view video tasks."""

    dataset_dir: str
    """Root directory that contains the videos.
       Can be a local folder (e.g. /data/videos) or an S3 URI (s3://bucket/prefix)."""

    api_key: str
    """Label-Studio API token. Create one in ➜ Account & Settings → Access Tokens."""

    base_url: str = "http://localhost:8080/"
    """Full URL where Label-Studio is reachable. Change it if you run LS on another host/port."""

    project_id: int = -1
    """Existing project to reuse.  
       == -1  → create a new project (default).  
       != -1 → import into that project ID instead of creating one."""

    project_name: str = None
    """Title for the **new** project (only used when project_id=-1).  
       If omitted, the script will generate “New Project #<id>”."""

    storage_name: str = None
    """Human-readable name for the import-storage connection that will be created.  
       If omitted, the script uses “Storage #<n>”."""


def name2key(view_name, view_dirname):
    if (
        "ego" in view_name or "top" in view_name or "head" in view_name
    ) and "right" not in view_name:
        view_key = "ego_view"
    elif (
        "ego" in view_name or "top" in view_name or "head" in view_name
    ) and "right" in view_name:
        view_key = "right_ego_view"
    elif "left" in view_name:
        view_key = "left_wrist_view"
    elif "right" in view_name:
        view_key = "right_wrist_view"
    else:
        raise ValueError(f"Unknown view name: {view_name} (from dir {view_dirname})")
    return view_key


def build_s3_tasks_map(bucket: str, prefix: str = ""):
    """
    traverse  s3://bucket/path/*.mp4 files,
    analyze view_key, return tasks_map.

    return format
    -------
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
        print("AWS call failed:", e)
        raise

    return tasks_map


def main(cfg: Config):
    client = LabelStudio(base_url=cfg.base_url, api_key=cfg.api_key)
    print("whoami and token:")
    print(client.users.whoami())
    print(client.users.get_token())

    print("list users:")
    print(client.users.list())
    if cfg.project_id == -1:
        label_config = """
<View>
    <Style>
        .video-row {
            display: flex;
            flex-wrap: nowrap;
            gap: 1em;
            width: 100%;
        }
        
        .video-item {
            flex: 1;
            min-width: 0;
        }
        
        .timeline-container {
            width: 100% !important;
            margin-top: 1em;
        }
        
        .timeline-container .video-segmentation {
            width: 100% !important;
        }
        
        .timeline-container .video-segmentation__timeline {
            width: 100% !important;
        }
        
        .timeline-container .video-segmentation__main {
            display: none !important;
        }
    </Style>
    
    <View className="video-row">
        <View className="video-item">
            <Video name="left_wrist_view"
                value="$left_wrist_view"
                sync="ego_view"
                height="400"
                frameRate="15.0"/>
        </View>

        <View className="video-item">
            <Video name="ego_view_display"
                value="$ego_view"
                sync="ego_view"
                height="400"
                frameRate="15.0"/>
        </View>

        <View className="video-item">
            <Video name="right_wrist_view"
                value="$right_wrist_view"
                sync="ego_view"
                height="400"
                frameRate="15.0"/>
        </View>
    </View>

    <View className="timeline-container">
        <Video name="ego_view"
            value="$ego_view"
            sync="ego_view"
            timelineHeight="250"
            height="1"
            frameRate="15.0"/>
        
        <VideoRectangle name="box"
                        toName="ego_view"
                        perFrame="true"/>
        <Labels name="videoLabels"
                toName="ego_view">
            <Label value="Subgoal"    background="#944BFF"/>
            <Label value="Suboptimal" background="#FFA500"/>
            <Label value="Failure"    background="#FF0000"/>
        </Labels>
    </View>
</View>
        """
        print("Creating new project...")
        if cfg.project_name is None:
            project = client.projects.create(
                title="New Project",
                label_config=label_config,
            )
            client.projects.update(
                id=project.id,
                title=f"New Project #{project.id}",
            )
        else:
            project = client.projects.create(
                title=cfg.project_name, label_config=label_config
            )

    else:
        print("Reusing existing project...")
        project = client.projects.get(id=cfg.project_id)

    print("Project ID:", project.id)
    print("Project title:", project.title)

    # collect tasks grouped by (chunk, filename) so each dict contains all available views
    tasks_map = {}
    if cfg.storage_name is None:
        title = f"Import Storage {cfg.dataset_dir}"
    else:
        title = f"Import Storage {cfg.storage_name}"
    if cfg.dataset_dir.startswith("s3://"):
        bucket, prefix = cfg.dataset_dir.replace("s3://", "").split("/", 1)
        prefix = prefix.rstrip("/") + "/videos/"
        for st in client.import_storage.s3.list(project=project.id):
            if st.title == title:
                print(f"[import] Reusing existing S3 import connection: {title}")
                return st
        storage = client.import_storage.s3.create(
            project=project.id,
            recursive_scan=True,
            regex_filter=".*\.(mp4|avi|mov|wmv|webm)$",
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
        print(
            f"[import] Created new S3 import connection: {title} -> s3://{bucket}/{prefix}"
        )
    else:
        local_path = os.path.join(cfg.dataset_dir, "videos")
        for st in client.import_storage.local.list(project=project.id):
            if st.title == title:
                print(f"[import] Reusing existing Local import connection: {title}")
                return st
        storage = client.import_storage.local.create(
            path=local_path,
            project=project.id,
            regex_filter=".*\.(mp4|avi|mov|wmv|webm)$",
            title=title,
            use_blob_urls=True,
        )
        for root, _, files in os.walk(local_path):
            for video_filename in files:
                if not video_filename.endswith(".mp4"):
                    continue
                video_path = os.path.join(root, video_filename)

                # determine view directory name (parent dir) and canonical view name
                view_dirname = os.path.basename(root)
                view_name = view_dirname.split(".")[-1]

                view_key = name2key(view_name, view_dirname)

                # group by chunk + filename to avoid collisions across chunks
                rel = os.path.relpath(video_path, local_path)
                parts = rel.split(os.sep)
                chunk = parts[0] if parts else ""
                print(chunk, video_filename, view_key)
                group_key = f"{chunk}/{video_filename}"

                tasks_map.setdefault(group_key, {})
                tasks_map[group_key][
                    view_key
                ] = f"/data/local-files/?d={os.path.abspath(video_path).lstrip('/home/gear/Videos/lerobot_storage/')}"
        print(f"[import] Created new Local import connection: {title} -> {local_path}")
    # final tasks list in requested format: list of dicts

    tasks_json = list(tasks_map.values())

    tasks = client.projects.import_tasks(
        request=tasks_json,
        id=project.id,
        return_task_ids=True,
    )
    print(f"Prepared {tasks.task_count} tasks")
    return project.id


def ensure_export_storage(cfg: Config, project_id: int):
    """
    Create (or reuse) an export-storage connection for the given project.
    Returns the storage object returned by the SDK.
    """
    client = LabelStudio(base_url=cfg.base_url, api_key=cfg.api_key)

    # consistent naming rule, same as import
    if cfg.storage_name is None:
        title = f"Export Storage {cfg.dataset_dir}"
    else:
        title = f"Export Storage {cfg.storage_name}"

    # assemble export path
    if cfg.dataset_dir.startswith("s3://"):
        bucket, prefix = cfg.dataset_dir.replace("s3://", "").split("/", 1)
        prefix = prefix.rstrip("/") + "/annotations"
        # list existing connections first to avoid duplicates
        for st in client.export_storage.s3.list(project=project_id):
            if st.title == title:
                print(f"[export] Reusing existing S3 export connection: {title}")
                return st

        st = client.export_storage.s3.create(
            project=project_id,
            bucket=bucket,
            prefix=prefix,
            aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
            region_name="us-east-1",  # modify if needed
            s3endpoint=os.environ.get("S3_ENDPOINT_URL", None),
            title=title,
            can_delete_objects=False,  # forbid deletion for safety
        )
        print(
            f"[export] Created new S3 export connection: {title} -> s3://{bucket}/{prefix}"
        )
    else:
        # local directory
        local_path = os.path.join(cfg.dataset_dir, "annotations")
        os.makedirs(local_path, exist_ok=True)

        for st in client.export_storage.local.list(project=project_id):
            if st.title == title:
                print(f"[export] Reusing existing Local export connection: {title}")
                return st

        st = client.export_storage.local.create(
            project=project_id,
            path=local_path,
            title=title,
            use_blob_urls=False,  # export uses only json/csv
        )
        print(f"[export] Created new Local export connection: {title} -> {local_path}")

    return st


if __name__ == "__main__":
    cfg = tyro.cli(Config)
    project_id = main(cfg)

    ensure_export_storage(cfg, project_id=int(project_id))
