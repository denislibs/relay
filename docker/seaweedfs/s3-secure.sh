#!/bin/sh
# Production S3 (docker-compose.secure.yml): учётка — из секретов (S3_*_FILE, docker secrets), а не из репозитория
# (INFRA-2); права — чтение, запись и список бакета вложений, без Admin. S3 отвечает только по https (сертификат
# внутреннего CA). Конфиг с ключами — во временном файле 600, не в аргументах и не в окружении контейнера.
set -eu
: "${S3_BUCKET:?}"
key_id=$(cat "${S3_ACCESS_KEY_ID_FILE:?}"); secret=$(cat "${S3_SECRET_ACCESS_KEY_FILE:?}")
umask 077
cat > /tmp/s3.json <<JSON
{ "identities": [ { "name": "relay-server",
  "credentials": [{ "accessKey": "${key_id}", "secretKey": "${secret}" }],
  "actions": ["Read:${S3_BUCKET}", "Write:${S3_BUCKET}", "List:${S3_BUCKET}"] } ] }
JSON
unset key_id secret
exec weed server -dir=/data -ip=s3 -ip.bind=0.0.0.0 -s3 -s3.config=/tmp/s3.json -master.volumeSizeLimitMB=1024 \
  -s3.cert.file=/certs/s3.pem -s3.key.file=/certs/s3-key.pem
