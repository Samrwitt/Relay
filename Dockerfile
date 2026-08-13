FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY server ./server
ENV NODE_ENV=production
ENV RELAY_HTTP=1
ENV PORT=3478
EXPOSE 3478
CMD ["node", "server/index.js"]
