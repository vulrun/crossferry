# CrossFerry forward proxy alone. Build context is the repository root:
#   docker build -f services/proxy/deploy/docker/Dockerfile -t crossferry-forward .
# To run it together with the CORS proxy, use the Dockerfile at the repository root instead.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# workspace manifests first so the dependency layer caches (the only dependency is the shared package)
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/proxy/package.json ./services/proxy/package.json
RUN npm ci --omit=dev --workspace=@crossferry/proxy --ignore-scripts --no-audit --no-fund

COPY packages/shared/src ./packages/shared/src
COPY services/proxy/index.js ./services/proxy/index.js
COPY services/proxy/src ./services/proxy/src

USER node
EXPOSE 3128

# TCP check: the proxy has no health endpoint, so just confirm the port accepts connections
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('net').connect(process.env.CROSSFERRY_PORT || 3128, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"

CMD ["node", "services/proxy/index.js"]
