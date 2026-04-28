# 更新日志

## v1.2.0 (2026-04-28)

### 新增
- **Teable OAuth 单点登录** — 登录页面新增「用 Teable 账号登录」按钮，支持通过 Teable OAuth 授权自动创建账号并登录
- **OAuth 回调自动处理** — 前端自动检测 URL 中的 `oauth_token` 参数，完成登录后清理 URL
- **用户管理 API** — 超级管理员可查看/删除用户
- **密码修改** — 个人中心支持修改密码

### 修复
- OAuth token 端点从 `/api/oauth/token` 修正为 `/api/oauth/access_token`
- OAuth 请求 Content-Type 改为 `application/x-www-form-urlencoded`

## v1.1.0 (2026-04-28)

### 新增
- **用户认证系统** — JWT 登录/注册、bcrypt 密码加密
- **Teable OAuth 2.0 授权连接** — 在 Web UI 内完成 OAuth 授权流程，无需手动复制粘贴 Token
- **OAuth 状态管理** — 显示已连接账号、断开重连

### 改进
- README 新增 OAuth FAQ 和 API 接口文档

## v1.0.0 (2026-04-27)

### 新增
- **核心同步引擎** — SQL Server / MySQL / PostgreSQL → Teable 数据同步
- **全量同步 + 增量同步** — 基于时间戳列（updated_at）
- **Upsert / Skip 冲突策略** — 主键冲突自动更新或跳过
- **自动建字段** — 检测源表新增列，自动在 Teable 创建对应字段
- **字段类型映射** — SQL 类型自动转换为 Teable 类型
- **可视化 Web 管理界面** — 暗色主题仪表盘（连接管理 / 同步任务 / 日志面板）
- **实时同步日志** — WebSocket 推送
- **定时调度** — 手动触发或定时自动同步
- **连接测试** — 保存前验证连通性
- **Docker 部署支持** — Dockerfile + docker-compose.yml