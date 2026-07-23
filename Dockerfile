# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./

COPY package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build

# Production stage
FROM node:22-alpine

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package.json ./

COPY package-lock.json ./

# Install only production dependencies (skip lifecycle scripts so the
# "prepare" -> husky step, a devDependency, doesn't run in production)
RUN npm ci --omit=dev --ignore-scripts

# Copy prisma schema for runtime
COPY prisma ./prisma

# Generate Prisma Client using locally installed version
RUN npx --yes prisma@5.22.0 generate

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create non-root user
RUN addgroup -g 1001 appgroup && \
    adduser -D -u 1001 -G appgroup appuser && \
    chown -R appuser:appgroup /app

USER appuser

CMD [ "node", "dist/main.js" ]

EXPOSE 4007
