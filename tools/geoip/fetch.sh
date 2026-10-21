#!/bin/sh
# База «IP → страна и город» для «Новый вход» (apps/server/src/geoip.ts). DB-IP City Lite — бесплатная, CC BY 4.0
# (нужна ссылка на db-ip.com в описании сервиса), обновляется раз в месяц. Альтернатива — MaxMind GeoLite2-City
# (своя лицензия и ключ). Кладёт файл в data/geoip/city.mmdb; путь для сервера — GEOIP_DB.
set -eu
dir="${1:-data/geoip}"
month="$(date -u +%Y-%m)"
mkdir -p "$dir"
curl -fsSL "https://download.db-ip.com/free/dbip-city-lite-$month.mmdb.gz" | gunzip > "$dir/city.mmdb.tmp"
mv "$dir/city.mmdb.tmp" "$dir/city.mmdb"
echo "geoip: $dir/city.mmdb ($(du -h "$dir/city.mmdb" | cut -f1))"
