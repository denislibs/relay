#!/bin/sh
# Production S3 (docker-compose.secure.yml): учётка — из окружения, а не из репозитория (INFRA-2); права —
# чтение, запись и список бакета вложений, без Admin. S3 отвечает только по https (сертификат внутреннего CA).
set -eu
: "${S3_ACCESS_KEY_ID:?}"; : "${S3_SECRET_ACCESS_KEY:?}"; : "${S3_BUCKET:?}"
umask 077
cat > /tmp/s3.json <<JSON
{ "identities": [ { "name": "relay-server",
  "credentials": [{ "accessKey": "${S3_ACCESS_KEY_ID}", "secretKey": "${S3_SECRET_ACCESS_KEY}" }],
  "actions": ["Read:${S3_BUCKET}", "Write:${S3_BUCKET}", "List:${S3_BUCKET}"] } ] }
JSON
exec weed server -dir=/data -ip=s3 -ip.bind=0.0.0.0 -s3 -s3.config=/tmp/s3.json -master.volumeSizeLimitMB=1024 \
  -s3.cert.file=/certs/s3.pem -s3.key.file=/certs/s3-key.pem
