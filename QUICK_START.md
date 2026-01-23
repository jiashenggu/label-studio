# Quick Start Guide

## 模式说明

### 🤖 LeRobot Mode (lerobot)
用于导入 **视频文件** (本地或S3存储)
- 适用于: 已有的视频数据集
- 数据源: 本地文件系统或S3
- 格式: MP4, AVI, MOV等视频文件

### 📦 PackDS Mode (packds)  
用于导入 **帧序列** (从LanceDB)
- 适用于: 存储在LanceDB中的JPEG帧
- 数据源: LanceDB frame server
- 格式: JPEG帧序列 → 自动生成MP4视频

---

## 使用方法

### PackDS Mode (推荐用于帧序列数据)

**步骤 1: 启动Frame Server**
```bash
source .venv/bin/activate
python lancedb_frame_server.py \
  --lancedb-path ./lancedb_data \
  --fps 15.0
```

**步骤 2: 创建任务**
```bash
python create_tasks.py \
  --mode packds \
  --frame-server-url http://localhost:8000 \
  --api-key YOUR_TOKEN \
  --max-episodes 100
```

**完整参数:**
```bash
python create_tasks.py \
  --mode packds \
  --frame-server-url http://localhost:8000 \
  --api-key YOUR_TOKEN \
  --base-url http://localhost:8080/ \
  --project-name "My PackDS Project" \
  --max-episodes 100 \
  --episode-filter 0 \
  --fps 15.0
```

---

### LeRobot Mode (用于视频文件)

**本地文件:**
```bash
python create_tasks.py \
  --mode lerobot \
  --dataset-dir /path/to/videos \
  --api-key YOUR_TOKEN
```

**S3存储:**
```bash
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
export S3_ENDPOINT_URL="https://s3.amazonaws.com"

python create_tasks.py \
  --mode lerobot \
  --dataset-dir s3://bucket/prefix \
  --api-key YOUR_TOKEN \
  --storage-name "My S3 Storage"
```

---

## 参数说明

### 通用参数
- `--mode`: 模式选择 (`lerobot` 或 `packds`)
- `--api-key`: Label Studio API令牌
- `--base-url`: Label Studio地址 (默认: `http://localhost:8080/`)
- `--project-id`: 使用已有项目ID (默认: -1 创建新项目)
- `--project-name`: 新项目名称
- `--fps`: 视频帧率 (默认: 15.0)

### LeRobot模式特有参数
- `--dataset-dir`: 视频目录路径或S3 URI
- `--storage-name`: 存储连接名称

### PackDS模式特有参数
- `--frame-server-url`: Frame server地址
- `--max-episodes`: 最大导入episode数 (默认: 100)
- `--episode-filter`: 只导入指定episode

---

## 获取API Key

1. 打开Label Studio: http://localhost:8080/
2. 点击右上角账户 → **Account & Settings**
3. 进入 **Access Token** 标签
4. 点击 **Create Token** 创建新令牌
5. 复制token用于 `--api-key` 参数

---

## 目录结构要求

### LeRobot模式
```
dataset_dir/
├── videos/
│   ├── chunk_001/
│   │   ├── 01.head_camera/
│   │   │   └── video_001.mp4
│   │   ├── 02.left_wrist/
│   │   │   └── video_001.mp4
│   │   └── 03.right_wrist/
│   │       └── video_001.mp4
│   └── chunk_002/
│       └── ...
└── annotations/  (自动创建)
```

### PackDS模式
```
./
├── lancedb_data/           # LanceDB数据库
├── video_cache/            # 生成的视频缓存
└── annotations_episodes/   # 导出的标注
```

---

## 常见问题

**Q: PackDS模式下视频加载很慢?**  
A: 第一次访问会生成视频(5-30秒)，之后会使用缓存，加载很快。

**Q: 如何清理视频缓存?**  
A: 删除 `video_cache/` 或 `/tmp/labelstudio_videos/` 目录。

**Q: LeRobot模式找不到视频?**  
A: 检查目录结构是否正确，视频文件名是否匹配命名规则。

**Q: 如何重新导入到同一个项目?**  
A: 使用 `--project-id <ID>` 参数指定已有项目。

---

## 示例命令

**快速测试 (PackDS):**
```bash
# 只导入第一个episode测试
python create_tasks.py \
  --mode packds \
  --frame-server-url http://localhost:8000 \
  --api-key abc123 \
  --episode-filter 0
```

**生产环境 (LeRobot + S3):**
```bash
python create_tasks.py \
  --mode lerobot \
  --dataset-dir s3://my-bucket/robotics-data \
  --api-key abc123 \
  --project-name "Production Dataset Q1 2026" \
  --storage-name "S3 Production Storage"
```

**批量处理 (PackDS):**
```bash
python create_tasks.py \
  --mode packds \
  --frame-server-url http://localhost:8000 \
  --api-key abc123 \
  --max-episodes 500 \
  --fps 30.0
```

