#!/bin/sh
# Внутренний CA и сертификаты сервисов для docker-compose.secure.yml (TLS между сервисами, mTLS к Postgres).
#   sh tools/tls/make-internal-certs.sh [каталог=secrets/tls]
# Ключи — только на сервере развёртывания, в репозиторий не попадают (.gitignore: secrets/). CA живёт 10 лет,
# сертификаты сервисов — 1 год: перевыпуск — запустить скрипт снова (CA сохраняется, если уже есть).
set -eu
dir="${1:-secrets/tls}"
umask 077
mkdir -p "$dir"
cd "$dir"
if [ ! -f ca.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=relay-internal-ca" -keyout ca-key.pem -out ca.pem 2>/dev/null
fi
# имя файла | CN | DNS-имена (через запятую) | назначение: server | client
issue() {
  name="$1"; cn="$2"; dns="$3"; use="$4"
  san=""; for d in $(echo "$dns" | tr ',' ' '); do san="${san:+$san,}DNS:$d"; done
  eku=$([ "$use" = client ] && echo clientAuth || echo serverAuth)
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$cn" -keyout "$name-key.pem" -out "$name.csr" 2>/dev/null
  printf "subjectAltName=%s\nextendedKeyUsage=%s\nbasicConstraints=CA:FALSE\n" "$san" "$eku" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 365 -extfile "$name.ext" -out "$name.pem" 2>/dev/null
  rm -f "$name.csr" "$name.ext"
}
issue postgres postgres postgres,pg server
issue valkey   valkey   valkey,vk     server
issue s3       s3       s3            server
issue search   search   search        server
issue keys     keys     keys          server
issue client   relay    relay         client     # server, worker, migrate — клиентский сертификат к Postgres (mTLS)
# Postgres читает ключ, только если он принадлежит его пользователю (uid 70 в alpine-образе) и закрыт для остальных
chmod 600 ./*-key.pem
chmod 644 ./*.pem 2>/dev/null || true
chmod 600 ./*-key.pem
echo "internal certs in $dir: ca.pem + postgres, valkey, s3, search, keys (server) and client (mTLS)"
