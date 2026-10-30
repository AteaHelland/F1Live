FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

WORKDIR /app
COPY package.json ./
# Headless Chromium only (the smaller build) plus the system libraries it needs.
RUN npm install --omit=dev \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /root/.npm /var/lib/apt/lists/*

COPY login.mjs ./

USER node
CMD ["node", "login.mjs"]
