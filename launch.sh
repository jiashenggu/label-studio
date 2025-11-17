sudo docker rm -f ls 2>/dev/null
# run background
sudo docker run -d \
    --name ls \
    --env-file ls.env \
    -p 8080:8080 \
    -v $(pwd)/mydata:/label-studio/data \
    -v ~/Videos/lerobot_storage:/home/gear/Videos/lerobot_storage:ro \
    scruple/label-studio:latest \
    label-studio \
    --log-level DEBUG

# run interactive
# sudo docker run -it \
#     --name ls \
#     --env-file ls.env \
#     -p 8080:8080 \
#     -v $(pwd)/mydata:/label-studio/data \
#     -v ~/Videos/lerobot_storage:/home/gear/Videos/lerobot_storage:ro \
#     scruple/label-studio:latest \
#     label-studio \
#     --log-level DEBUG

until curl -s http://localhost:8080/health > /dev/null; do
  sleep 1
done

export AWS_ACCESS_KEY_ID=""
export AWS_SECRET_ACCESS_KEY=""
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ENDPOINT_URL="https://pdx.s8k.io"
export S3_ENDPOINT_URL="https://pdx.s8k.io"

python create_tasks.py \
    --dataset_dir s3://data/jiashengg  \
    --api_key label-studio-api-key