FROM oven/bun:1.4.4
# ffmpeg/ffprobe — обработка видео в воркере (apps/server/src/jobs/video.ts)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/sync-engine/package.json packages/sync-engine/
COPY packages/relay-ui/package.json packages/relay-ui/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun apps/web/build.ts
# не от root (INFRA-5): ffmpeg разбирает чужие файлы; процессу не нужно ничего, кроме чтения /app и /tmp
RUN chown -R bun:bun /app/apps/web/dist
USER bun
EXPOSE 3000
CMD ["bun", "apps/server/src/main.ts"]
