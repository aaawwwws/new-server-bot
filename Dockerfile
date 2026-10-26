# ---- ビルド（TypeScript → JavaScript）
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 実行（本番用の依存とビルド結果だけを入れる）
FROM node:22-alpine
ENV NODE_ENV=production
# レベルの画像カードに日本語と絵文字を描くためのフォント
RUN apk add --no-cache font-noto-cjk font-noto-emoji
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
