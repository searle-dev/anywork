FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

ENV SERVER_PORT=3001
EXPOSE 3001

CMD ["node", "dist/index.js"]
