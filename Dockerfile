FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ src/

ENV ROUTER_HOST=0.0.0.0
EXPOSE 9000

CMD ["node", "--import", "./node_modules/tsx/dist/esm/index.mjs", "src/webhook-router.ts"]
