# TeableSync Docker 镜像
# 多阶段构建：构建前端 → 运行后端

FROM node:20-alpine AS builder

WORKDIR /app

# 复制前端代码并构建
COPY client/ ./client/
RUN cd client && npm install && npm run build

# 最终运行镜像
FROM node:20-alpine

WORKDIR /app

ARG APP_VERSION=1.0.0
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV APP_VERSION=$APP_VERSION
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_TIME=$BUILD_TIME

# Runtime SQLite is used for growing operational data such as history, failures, and audit logs.
RUN apk add --no-cache sqlite

# 安装生产依赖（只装 server 的）
COPY server/ ./server/
RUN cd server && npm install --omit=dev

# 从构建阶段复制前端产物
COPY --from=builder /app/client/dist ./client/dist

# 暴露端口
EXPOSE 3101

# 启动命令
CMD ["sh", "-c", "cd server && PORT=3101 node src/index.js"]
