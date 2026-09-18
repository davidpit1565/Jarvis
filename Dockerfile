# Runs JARVIS Core (chat + WebSocket + Twilio phone webhooks) as a single
# always-on process with a public HTTPS URL, so Twilio can reach it without
# depending on a personal machine being on and connected.
FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# The interactive terminal chat loop (readline on stdin) is irrelevant in a
# container with no attached TTY; only the HTTP/WebSocket server matters
# here, but src/index.ts starts both, and the readline loop is harmless
# with no stdin attached (it simply never receives a line).
ENV NODE_ENV=production
EXPOSE 4770

CMD ["bun", "run", "src/index.ts"]
