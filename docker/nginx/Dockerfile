# nginx с brotli. Пакет Alpine отстаёт от исправлений nginx (октябрь 2026: CVE-2026-15176, -95101, -97629, -97205
# в 3.21–3.23 не перенесены), поэтому — официальный образ нужной версии и модуль ngx_brotli, собранный под него.
# Обновление nginx: поменять NGINX и NGINX_SHA256 (sha256 tar.gz с nginx.org).
ARG NGINX=1.30.6

FROM nginx:${NGINX}-alpine AS brotli
ARG NGINX
ARG NGINX_SHA256=3cf46f5ed7504d460125866b7bea99fb357f31d887e2e63b35503310e9b8b6c8
ARG NGX_BROTLI=53e0fb55f250f48fe80c0ddbf6c0f7103cdbaae1
ARG NGX_BROTLI_SHA256=27a4352dae4ba4922f9f013f3f0d02359aceeef2701872efa42849c3ba05457a
RUN apk add --no-cache build-base pcre2-dev openssl-dev zlib-dev brotli-dev linux-headers
WORKDIR /build
# brotli — системный (brotli-dev), а не подмодуль: модуль ищет заголовки в deps/brotli/c/include
RUN wget -qO nginx.tar.gz https://nginx.org/download/nginx-${NGINX}.tar.gz \
 && echo "${NGINX_SHA256}  nginx.tar.gz" | sha256sum -c - \
 && wget -qO ngx_brotli.tar.gz https://codeload.github.com/google/ngx_brotli/tar.gz/${NGX_BROTLI} \
 && echo "${NGX_BROTLI_SHA256}  ngx_brotli.tar.gz" | sha256sum -c - \
 && tar xzf nginx.tar.gz && tar xzf ngx_brotli.tar.gz \
 && mkdir -p ngx_brotli-${NGX_BROTLI}/deps/brotli/c && ln -s /usr/include ngx_brotli-${NGX_BROTLI}/deps/brotli/c/include \
 && cd nginx-${NGINX} && ./configure --with-compat --add-dynamic-module=../ngx_brotli-${NGX_BROTLI} \
 && make modules

FROM nginx:${NGINX}-alpine
RUN apk add --no-cache brotli-libs
COPY --from=brotli /build/nginx-*/objs/ngx_http_brotli_filter_module.so /build/nginx-*/objs/ngx_http_brotli_static_module.so /etc/nginx/modules/
COPY nginx.conf /etc/nginx/nginx.conf
CMD ["nginx", "-g", "daemon off;"]
