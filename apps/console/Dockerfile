# TuneDeck console image. Build from apps/console: docker build -t tunedeck-console apps/console
# next/font downloads the Google fonts once during the build; staff browsers never call Google.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY next.config.ts tsconfig.json next-env.d.ts ./
COPY src ./src
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/next.config.ts ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/.next ./.next
# Next writes its image/fetch cache under .next/cache; give the unprivileged user only that.
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3200/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node_modules/.bin/next", "start", "-p", "3200"]
