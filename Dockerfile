FROM node:24.12.0-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.12.0-alpine AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm pkg delete scripts.prepare && npm ci --omit=dev

FROM node:24.12.0-alpine AS runner

WORKDIR /app

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont dumb-init

ENV NODE_ENV=production \
    REDIS_ENABLED=true \
    REDIS_DB=0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

USER node

RUN chromium --version

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/docs-json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

CMD ["sh", "-c", "node node_modules/typeorm/cli.js migration:run -d dist/data-source.js && exec node dist/main.js"]
