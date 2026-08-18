# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./

COPY package-lock.json ./

RUN npm ci

COPY prisma ./prisma

RUN ./node_modules/.bin/prisma generate

COPY . .

RUN npm run build

# Production stage
FROM node:22-alpine

# Marks this as an optimized runtime build (Express/library fast paths, no
# dev-only work). It is NOT how staging and production are told apart — the
# same image build serves both. That distinction is ENVIRONMENT, which comes
# from the compose env_file (.env.staging / .env.prod).
ENV NODE_ENV=production

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package.json ./

COPY package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy prisma schema for runtime
COPY prisma ./prisma

# Generate Prisma Client using locally installed version
RUN ./node_modules/.bin/prisma generate

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create non-root user
RUN addgroup -g 1001 appgroup && \
    adduser -D -u 1001 -G appgroup appuser && \
    chown -R appuser:appgroup /app

USER appuser

CMD [ "node", "dist/src/main.js" ]

EXPOSE 4007
