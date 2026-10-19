#!/bin/sh
# Сертификат для https://localhost в dev. Нужен mkcert (brew install mkcert) и его корень в системе:
#   mkcert -install   (один раз; спросит пароль)
set -e
cd "$(dirname "$0")"
mkdir -p certs
mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1
