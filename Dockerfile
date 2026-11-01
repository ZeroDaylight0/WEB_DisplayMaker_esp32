# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    PIXELFORGE_DATA_DIR=/data
WORKDIR /app
# The server only uses Node.js built-ins at runtime, so no node_modules are copied.
COPY --from=build /app/dist ./dist
COPY server.mjs package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4173/api/health || exit 1
CMD ["node", "server.mjs"]
