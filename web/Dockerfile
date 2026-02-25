FROM node:22-slim AS builder

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

# NEXT_PUBLIC_* = build-time vars, baked into client JS bundle
# Browser connects to host ports, so these point to localhost
ARG NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

ENV PORT=7000
ENV HOSTNAME=0.0.0.0
EXPOSE 7000

CMD ["node", "server.js"]
