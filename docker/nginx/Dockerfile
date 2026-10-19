# nginx с brotli: у официального образа модуля нет, у alpine он пакетом (подключается сам через /etc/nginx/modules)
FROM alpine:3.21
RUN apk add --no-cache nginx nginx-mod-http-brotli
CMD ["nginx", "-g", "daemon off;"]
