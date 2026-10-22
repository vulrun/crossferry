# CrossFerry: forward proxy on CROSSFERRY_PORT (3128) and CORS proxy on CROSSFERRY_CORS_PORT (8080).
#   docker build -t crossferry .
#   docker run crossferry            # both services (crossferry all)
#   docker run crossferry forward    # one of them
# Single-service images live in services/*/deploy/docker/.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# workspace manifests first so the dependency layer caches
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/proxy/package.json ./services/proxy/package.json
COPY services/cors/package.json ./services/cors/package.json
RUN npm ci --omit=dev --workspaces --ignore-scripts --no-audit --no-fund

COPY index.js healthcheck.js ./
COPY bin ./bin
COPY packages/shared/src ./packages/shared/src
COPY services/proxy/index.js ./services/proxy/index.js
COPY services/proxy/src ./services/proxy/src
COPY services/cors/src ./services/cors/src

USER node
EXPOSE 3128 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "healthcheck.js"]

ENTRYPOINT ["node", "bin/crossferry.js"]
CMD ["all"]
