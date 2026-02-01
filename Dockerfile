# Dockerfile - Production version for Render Starter
# Optimized, reliable, no bloat

FROM node:18-alpine

# Environment variables
ENV NODE_OPTIONS="--max-old-space-size=450"
ENV HOME=/tmp
ENV TMPDIR=/tmp

# Install only essential dependencies
RUN apk add --no-cache \
    graphicsmagick \
    poppler-utils \
    && rm -rf /var/cache/apk/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Build Tailwind CSS if needed
RUN if [ -f "tailwind.config.js" ]; then \
      npm install --no-save tailwindcss@^3.4.1 postcss@^8.4.35 autoprefixer@^10.4.17 && \
      npx tailwindcss -i ./src/input.css -o ./public/output.css --minify && \
      npm uninstall tailwindcss postcss autoprefixer; \
    fi

# Create directories
RUN mkdir -p uploads output public && \
    chmod 777 uploads output

# Expose port
EXPOSE 10000

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run with garbage collection enabled
CMD ["node", "--expose-gc", "server.js"]
