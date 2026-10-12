# The two websites: the dashboard (apps/dashboard) and the landing page (apps/landing), served by
# Caddy, which also forwards /api to the API over Railway's private network (deploy/railway/Caddyfile).
# Built from the repository root: "Dockerfile Path" = deploy/railway/web.Dockerfile.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Read at BUILD time by Vite. Railway passes a service variable to the build when it is declared here.
# Changing one needs a redeploy (a rebuild), not just a restart.
ARG VITE_APP_URL
ARG VITE_LEGAL_LINKS
ARG VITE_WAITLIST_URL
ARG VITE_TERMS_URL
ARG VITE_PRIVACY_URL
ARG VITE_WALLETCONNECT_PROJECT_ID
ARG VITE_SHOW_OPERATOR_LOGIN

COPY . .
RUN npm ci --no-audit --no-fund && npm run build

FROM caddy:2-alpine
COPY deploy/railway/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/dashboard/dist /srv/app
COPY --from=build /app/apps/landing/dist /srv/site
