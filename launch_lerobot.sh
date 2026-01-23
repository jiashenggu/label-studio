sudo docker rm -f ls 2>/dev/null

sudo docker run -d \
    -u $(id -u):$(id -g) \
    --name ls \
    --env-file ls.env \
    -p 0.0.0.0:8080:8080 \
    -v $(pwd)/mydata:/label-studio/data \
    -v ~/Videos/lerobot_storage:/home/gear/Videos/lerobot_storage \
    scruple/label-studio:latest \
    label-studio \
    --log-level DEBUG



until curl -s http://localhost:8080/health > /dev/null; do
  sleep 1
done

export AWS_ACCESS_KEY_ID="jiashenggu:AUTH_team-gear"
export AWS_SECRET_ACCESS_KEY="a950a4265f9d79628dc188ebb3a0eb4d"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ENDPOINT_URL="https://pdx.s8k.io"
export S3_ENDPOINT_URL="https://pdx.s8k.io"

python create_tasks.py \
    --dataset_dir s3://GrootDatasets/yam_lerobot_v5/xdof.assembly_2026-01-23_04-48-04_v4_USA \
    --api_key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoicmVmcmVzaCIsImV4cCI6ODA3MDYzNDg2MCwiaWF0IjoxNzYzNDM0ODYwLCJqdGkiOiJkMzQ3MDlkMWY4MDk0YTg0YmUwMGNhYTAxOGQwODVmMyIsInVzZXJfaWQiOiI0In0.OT8fXRdhod6MOWJl6UUS_m1wIOMoPj_KkTxAR8Mz4AE