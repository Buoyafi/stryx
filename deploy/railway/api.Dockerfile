# The API (apps/api). Built from the repository root: Railway service setting
# "Dockerfile Path" = deploy/railway/api.Dockerfile, root directory left empty.
# The scheduled-mint and signed-mint queues run inside this one process, so there is nothing
# else to deploy for them. Database migrations run as Railway's pre-deploy command (see
# docs/deployment/RAILWAY.md), not here, so a failed migration stops the release before it starts.
FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL; ca-certificates for every outbound HTTPS call (RPCs, OpenSea, AWS KMS).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

ENV NODE_ENV=production
# Not root: the API only reads its files. The pre-deploy migration and `railway ssh` run as this user too.
USER node
CMD ["node", "apps/api/dist/server.js"]
