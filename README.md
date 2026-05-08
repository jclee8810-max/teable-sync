# Teable Sync

SQL Server / MySQL / PostgreSQL 到 Teable 的同步工具，提供 Web 管理界面、任务调度、失败重试、一致性校验和基础运维能力。

## 主要能力

- 多源数据库：SQL Server、MySQL、PostgreSQL
- 同步模式：手动、定时、实时轮询、全量扫描、基于时间戳/rowversion/自增主键的增量同步
- 同步可靠性：源端分页、Teable 批量写入、重试、限流、失败批次记录和重试
- 删除策略：忽略删除、软删除标记、物理删除
- 字段能力：字段映射、类型转换、缺失字段自动创建
- 安全：用户登录、角色权限、共享连接脱敏、配置密钥加密存储
- 运维：系统检查、操作审计、配置自动备份、任务健康状态、端到端 smoke 验收

## Docker 部署

```bash
cp .env.example .env
# 编辑 .env，至少修改 JWT_SECRET 和 CONFIG_ENCRYPTION_KEY

docker compose up -d --build
```

访问：

```text
http://localhost:3101
```

默认 `docker-compose.yml` 只启动 `teable-sync` 应用和它的运行数据卷，不再附带任何测试数据库。SQL 数据源和 Teable 数据源请在 Web 界面的“数据源”里配置。

## 本地开发

```bash
npm install
cd server && npm install && cd ..
cd client && npm install && cd ..

npm run dev
```

开发模式：

- 后端：`http://localhost:3101`
- 前端 Vite：`http://localhost:5173`

生产构建：

```bash
npm run build
npm start
```

## 关键环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3101` | Web/API 监听端口 |
| `SERVER_PUBLIC_URL` | `http://localhost:3101` | OAuth 回调使用的服务公开地址 |
| `FRONTEND_BASE_URL` | `http://localhost:3101` | OAuth 登录后跳回的前端地址 |
| `TEABLE_OAUTH_HOST` | `http://localhost:3000` | Teable 实例地址 |
| `JWT_SECRET` | 示例值 | JWT 签名密钥，生产必须修改 |
| `CONFIG_ENCRYPTION_KEY` | 示例值 | 配置密钥加密密钥，设置后请稳定保存 |
| `TEABLE_RATE_LIMIT_MS` | `120` | Teable API 请求间隔 |
| `AUTO_RESUME_TASKS` | `true` | 容器重启后恢复已启用任务定时器 |
| `AUTO_RESUME_RUN_IMMEDIATELY` | `false` | 自动恢复后是否立刻跑一次同步 |
| `RECONCILE_DATE_TIME_ZONE` | `Asia/Shanghai` | 一致性校验日期字段的业务时区 |

敏感配置会保存在 `server/data/config.json`。已支持加密字段：`password`、`token`、`oauthClientSecret`、`teableOAuthToken`。

如果没有设置 `CONFIG_ENCRYPTION_KEY`，系统会用 `JWT_SECRET` 派生加密密钥。密钥丢失或更换后，已加密的连接密码和 Token 将无法解密。

## 基本使用流程

1. 注册第一个账号。第一个账号会自动成为 `super_admin`。
2. 在“数据源”里创建 SQL 数据源和 Teable 数据源。
3. 可以把连接设为共享；共享连接在列表接口里会自动脱敏。
4. 在“同步任务”里选择源表、目标表、主键列和字段映射。
5. 先用“预览”确认源数据，再手动运行一次同步。
6. 运行后查看任务健康、失败批次、操作审计和一致性校验结果。

## 同步策略说明

### 可靠性参数

- 源分页大小：默认 `1000`，最大 `5000`
- 写入批量：默认 `500`，最大 `1000`
- 失败重试次数：默认 `3`
- Teable 请求限流：`TEABLE_RATE_LIMIT_MS` 控制，默认 `120ms`

源端读取优先使用主键游标分页，避免大表 `OFFSET` 翻页变慢。Teable API 对 408、409、425、429、5xx 和网络错误做退避重试。

### 删除同步

删除检测只在全量扫描策略下执行：

- 忽略删除：只同步新增和更新
- 软删除标记：源端记录消失时，把目标记录的软删除字段设为 `true`
- 物理删除：源端记录消失时，从 Teable 删除目标记录

软删除字段默认是 `deleted`，可在任务里配置。

### 一致性校验

一致性校验是只读操作，会比较源表和目标表：

- 目标缺失
- 目标多余
- 字段不一致

日期字段会按业务时区归一化比较，避免 `2026-04-15` 和 `2026-04-14T16:00:00.000Z` 这类等价日期误报。

## 运维能力

管理员可以在“系统检查”里查看配置加密、数据目录写入、配置解密、备份、连接/任务引用完整性和待处理失败批次。

“日志”页面包含运行日志和操作审计。运行日志用于排查同步过程，操作审计用于查看用户、连接、任务和系统操作记录。

## 端到端 Smoke 验收

部署后可以运行 API 级端到端验收：

```bash
npm run e2e:smoke
```

脚本会使用当前系统里已有的数据源和 Teable 连接，创建 `codex-e2e-*` 临时任务和连接来验证主要流程。它不会要求默认 compose 启动测试数据库。

可选环境变量：

```bash
E2E_API_BASE=http://127.0.0.1:3101/api \
E2E_TEABLE_BASE_HINT=SyncPilot \
E2E_RUN_TIMEOUT_MS=30000 \
npm run e2e:smoke
```

## 常用命令

```bash
npm run dev
npm run build
npm start
npm run docker:up
npm run docker:down
npm run e2e:smoke
```

## 注意事项

- 生产环境必须修改 `JWT_SECRET` 和 `CONFIG_ENCRYPTION_KEY`。
- 如果修改了加密密钥，旧的加密连接密码和 Token 可能无法解密。
- 物理删除同步不可逆，启用前建议先使用软删除策略验证。
- `server/data/` 是运行数据目录，不应提交到 Git。
