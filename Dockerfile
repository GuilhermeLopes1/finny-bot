FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/

# Create logs directory
RUN mkdir -p logs

# Non-root user for security
RUN addgroup -g 1001 -S finny && adduser -S finny -u 1001
USER finny

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
