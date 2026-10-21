FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["npm", "start"]
