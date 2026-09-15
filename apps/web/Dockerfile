FROM node:22-alpine

WORKDIR /app

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

COPY apps/web ./
ARG API_INTERNAL_BASE_URL=http://api:8000
ENV API_INTERNAL_BASE_URL=$API_INTERNAL_BASE_URL
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
