# OpenBao — KMS главного ключа на том же сервере (deploy/docker-compose.prod.yml, docs/deploy.md).
# Боевой режим: хранилище на томе (зашифровано барьером, открывается ключами распечатки — они только у владельца),
# после каждого перезапуска — запечатан, пока владелец не выполнит deploy/bao-unseal.sh.
# Хранилище — встроенное (raft) на одном узле: storage "file" в OpenBao 2.x больше нет. Бэкап — снимок raft
# (deploy/backup.sh), а не копия файлов тома на ходу.
# Ходит к нему только сервис ключей (сеть bao), по TLS с сертификатом внутреннего CA (tools/tls/make-internal-certs.sh).
#
# mlock: OpenBao его больше не поддерживает (строка disable_mlock — ошибка конфига) — swap на хосте выключен
# или зашифрован (docs/deploy.md, «Подготовка сервера»).

storage "raft" {
  path    = "/openbao/file"   # том openbao-data; каталог образа, уже принадлежит openbao
  node_id = "relay-1"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  # копии с правами пользователя openbao: entrypoint в deploy/docker-compose.prod.yml
  tls_cert_file   = "/run/bao/bao.pem"
  tls_key_file    = "/run/bao/bao-key.pem"
  tls_min_version = "tls12"
}

api_addr     = "https://openbao:8200"
cluster_addr = "https://openbao:8201"   # raft требует; узел один, наружу не публикуется
ui           = false
