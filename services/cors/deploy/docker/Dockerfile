# CrossFerry CORS proxy alone. Build context is the repository root:
#   docker build -f services/cors/deploy/docker/Dockerfile -t crossferry-cors .
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# workspace manifests first so the dependency layer caches
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/cors/package.json ./services/cors/package.json
RUN npm ci --omit=dev --workspace=@crossferry/cors --ignore-scripts --no-audit --no-fund

COPY packages/shared/src ./packages/shared/src
COPY services/cors/src ./services/cors/src

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.CROSSFERRY_CORS_PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "services/cors/src/adapters/node.js"]
