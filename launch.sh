mkdir -p ./mydata
chmod -R 777 ./mydata
sudo docker run -it \
    --env-file ls.env \
    -p 8080:8080 \
    -v $(pwd)/mydata:/label-studio/data \
    -v ~/Videos/lerobot_storage:/home/gear/Videos/lerobot_storage:ro \
    scruple/label-studio:latest \
    label-studio \
    --log-level DEBUG

