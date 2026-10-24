FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 OWNERTRACKER_DB=/app/data/ownertracker.sqlite
EXPOSE 8787
CMD ["node","src/server.mjs"]
