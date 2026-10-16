FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# клиент OpenTimestamps для суточной фиксации даты в Bitcoin
RUN apk add --no-cache python3 py3-pip && pip3 install --no-cache-dir --break-system-packages opentimestamps-client
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY suites ./suites
COPY skills ./skills
COPY stand ./stand
COPY lab/agentkit.js ./lab/agentkit.js
USER node
EXPOSE 4040
CMD ["node", "src/server.js"]
