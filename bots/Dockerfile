FROM node:22-slim
WORKDIR /app/bots
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production STATE_DIR=/app/state LOG_FORMAT=json
RUN mkdir -p /app/state && chown node:node /app/state
USER node
# Deployment JSON is mounted at /app/contracts/deployments (see docker-compose.yml)
ENTRYPOINT ["npx", "tsx", "src/main.ts"]
CMD ["all"]
