FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server.js"]
