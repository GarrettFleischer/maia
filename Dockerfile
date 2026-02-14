# Maia - Personal AI Assistant
# Production image for consistent deployment. Requires MAIA_AUTH_TOKEN and
# MAIA_MASTER_KEY at runtime. See docs/deployment.md for reverse proxy and TLS.

FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install production dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy application source
COPY src ./src

# Default: run gateway (HTTP + watchdog + channels). Override CMD for chat/onboard/etc.
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["start"]
