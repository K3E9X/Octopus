# Octopus Leak — multi-stage build producing a tiny standalone image.
# Runs anywhere Node runs: Linux or Windows containers, Docker, Kubernetes, bare VM.
#
#   docker build -t octopus-leak .
#   docker run -p 3000:3000 octopus-leak
#
# Env (the app runs without any of it, and says what is missing rather than faking it):
#   LEAKOSINT_TOKEN          → the leak source. Absent: no report, stated as such.
#   POSTGRES_URL             → accounts, credits, audit trail. Absent: single-operator,
#                              unmetered, unlogged — never expose that publicly.
#   OCTOPUS_SESSION_SECRET   → required for sessions to be issued at all.
#   OCTOPUS_MARKUP           → resale margin over the raw API cost (default 1.6).

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- run ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# standalone output bundles only what's needed to run
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:3000/ >/dev/null 2>&1 || exit 1
CMD ["node", "server.js"]
