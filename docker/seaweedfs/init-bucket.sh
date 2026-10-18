#!/bin/sh
# Создать бакет вложений (идемпотентно). Ждём мастер: s3 стартует раньше, чем принимает команды shell.
set -e
for i in $(seq 1 60); do
  if out=$(echo "s3.bucket.list" | weed shell -master="$MASTER" 2>/dev/null) && [ -n "$out" ]; then break; fi
  sleep 1
done
if echo "s3.bucket.list" | weed shell -master="$MASTER" | grep -qw "$BUCKET"; then
  echo "bucket $BUCKET exists"
else
  echo "s3.bucket.create -name $BUCKET" | weed shell -master="$MASTER"
fi
