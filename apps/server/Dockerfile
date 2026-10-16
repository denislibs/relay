FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["bun", "apps/server/src/main.ts"]
