# TeableSync Docker 镜像
# 多阶段构建：构建前端 → 运行后端

FROM node:18-alpine AS builder

WORKDIR /app

# 复制前端代码并构建
COPY client/ ./client/
RUN cd client && npm install && npm run build

# 最终运行镜像
FROM node:18-alpine

WORKDIR /app

# 安装生产依赖（只装 server 的）
COPY server/ ./server/
RUN cd server && npm install --omit=dev

# 从构建阶段复制前端产物
COPY --from=builder /app/client/dist ./client/dist

# 暴露端口
EXPOSE 3100

# 启动命令
CMD ["sh", "-c", "cd server && node src/index.js"]
