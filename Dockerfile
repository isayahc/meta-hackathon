# Override with a tested digest when promoting a release.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY app/physical-task-tracker/package.json app/physical-task-tracker/package.json
RUN npm ci --ignore-scripts
COPY app/physical-task-tracker/tsconfig.json app/physical-task-tracker/tsconfig.json
COPY app/physical-task-tracker/scripts/copy-assets.mjs app/physical-task-tracker/scripts/copy-assets.mjs
COPY app/physical-task-tracker/src app/physical-task-tracker/src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/app/physical-task-tracker/package.json ./app/physical-task-tracker/package.json
COPY --from=build /app/app/physical-task-tracker/dist ./app/physical-task-tracker/dist
COPY docker /app/docker
# Existing Windows worktrees may still supply CRLF bytes to the build context.
RUN sed -i 's/\r$//' /app/docker/entrypoint.sh \
    && mkdir -p /data /config && chown node:node /data /config
ENV NODE_ENV=production APPDATA=/config
USER node
EXPOSE 8123
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
CMD ["node", "/app/app/physical-task-tracker/dist/serve-dashboard.js", "/data", "--host", "0.0.0.0", "--port", "8123"]
