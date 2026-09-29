# Host application must have an npm lockfile and a start script listening on $PORT.
# Deploy this host image to Cloud Run, ECS/Fargate or Azure App Service containers.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["npm", "start"]
