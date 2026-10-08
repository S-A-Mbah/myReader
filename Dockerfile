# ReadAloud in a container: same app, same versions, on any machine with Docker.
#
#   docker compose up --build        then open http://localhost:3000
#
# Debian (not Alpine): onnxruntime-node ships glibc binaries.
# Exact patch tag so every build uses the same Node.

FROM node:22.23.2-bookworm-slim AS deps
WORKDIR /app
# onnxruntime-node's install script downloads CUDA (GPU) binaries on Linux x64 by
# default. ReadAloud runs on the CPU, so skip them: hundreds of MB we never load.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
# Exact versions from the lockfile; no test or lint tools in the image.
# onnxruntime-node bundles macOS and Windows engine binaries (~130 MB) that can never
# load inside a Linux container, so they are removed; the Linux ones stay.
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v3/darwin node_modules/onnxruntime-node/bin/napi-v3/win32

FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    READALOUD_HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json config.json ./
COPY server ./server
COPY src ./src
COPY public ./public
# The voice model downloads here on first start. compose.yaml mounts a volume on this
# path so the ~330 MB download happens once, not on every new container. Created and
# owned by the unprivileged user so the volume inherits writable permissions.
RUN mkdir -p .cache/models && chown -R node:node .cache
USER node
EXPOSE 3000
# Healthy once the server answers (the model may still be loading; the page shows that).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.js"]
