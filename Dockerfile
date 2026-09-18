# Runs JARVIS Core (chat + WebSocket + Twilio phone webhooks) as a single
# always-on process with a public HTTPS URL, so Twilio can reach it without
# depending on a personal machine being on and connected.
FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./
# The standalone hologram visualizer (ui/hologram/) — served directly by
# Core at /hologram (see HOLOGRAM_UI_DIR in JarvisWebSocketServer.ts) so a
# deployed Core can hand any browser, including a phone's, one URL that
# shows the real, live Core. Without this the route 404s in production
# even though it works from a local checkout.
COPY ui ./ui

# The interactive terminal chat loop (readline on stdin) is irrelevant in a
# container with no attached TTY; only the HTTP/WebSocket server matters
# here, but src/index.ts starts both, and the readline loop is harmless
# with no stdin attached (it simply never receives a line).
ENV NODE_ENV=production
EXPOSE 4770

# Lets `docker ps` and any Docker-aware host (Railway, Render, a plain VPS
# running `docker run --health-cmd`) see whether the process is actually
# serving, not just alive — Fly.io uses its own [[http_service.checks]] in
# fly.toml instead, since Fly doesn't read Docker HEALTHCHECK.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:4770/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
