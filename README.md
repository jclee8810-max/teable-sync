# Teable Sync

Teable Sync 是一个面向局域网多人使用的同步工具，用于把 SQL Server / MySQL / PostgreSQL / Teable 的数据同步到 Teable。它提供 Web 管理界面、任务调度、失败重试、一致性校验、观测告警和配置迁移能力。

## 适用场景

- 团队在局域网内统一维护数据库到 Teable 的同步任务。
- 多个用户共用部分数据源，但不能在前端看到数据库密码、Teable Token 或 OAuth 密钥。
- 管理员需要查看任务健康、失败批次、操作审计，并把严重告警推送到 Teable 自动化或其他 Webhook 接收端。
- 一套配置需要从测试环境迁移到正式环境。

## 主要能力

- 数据源：SQL Server、MySQL、PostgreSQL、Teable。
- 同步方向：SQL -> Teable、Teable -> Teable、Teable <-> Teable 双向同步。
- 同步模式：手动、定时、准实时轮询、全量扫描、增量同步。
- 同步可靠性：源端分页、Teable 批量写入、重试、限流、失败批次记录和重试。
- 删除策略：忽略删除、软删除标记、物理删除。
- 字段能力：字段映射、类型转换、缺失字段自动创建、字段变更感知、字段快照刷新。
- 任务能力：预览、预检查、任务详情、任务模板、复制任务、同步前运行门禁。
- 校验能力：一致性校验会按业务时区处理日期字段。
- 权限安全：账号登录、管理员/普通用户角色、连接共享、列表脱敏、配置密钥加密存储。
- 运维能力：任务健康、观测告警、Webhook 告警通知、操作审计、运行日志、系统检查、配置导入导出、自动备份、端到端 smoke 验收。

## 一键部署：复制命令直接运行

这是推荐给普通用户的部署方式，不需要下载源码，也不需要懂代码。服务器或电脑只要已经安装 Docker Desktop / Docker Engine，就可以复制下面命令到终端执行。

镜像地址：

```text
ghcr.io/jclee8810-max/teable-sync:latest
```

首次发布镜像后，下面的 `docker compose pull` 才能拉到镜像。如果刚推送代码后立刻部署，请先等 GitHub Actions 的 Docker image workflow 构建完成。

### 本机部署

只在当前电脑访问时，复制下面整段命令到终端：

```bash
mkdir -p ~/teable-sync && cd ~/teable-sync
JWT_SECRET=$(openssl rand -hex 32)
CONFIG_ENCRYPTION_KEY=$(openssl rand -hex 32)
cat > .env <<ENV_FILE
PORT=3101
SERVER_PUBLIC_URL=http://localhost:3101
FRONTEND_BASE_URL=http://localhost:3101
TEABLE_OAUTH_HOST=http://localhost:3000
JWT_SECRET=$JWT_SECRET
CONFIG_ENCRYPTION_KEY=$CONFIG_ENCRYPTION_KEY
AUTO_RESUME_TASKS=true
AUTO_RESUME_RUN_IMMEDIATELY=false
TEABLE_RATE_LIMIT_MS=120
ALERT_NOTIFICATION_SCAN_INTERVAL_MS=60000
RECONCILE_DATE_TIME_ZONE=Asia/Shanghai
LOG_LEVEL=info
ENV_FILE
cat > docker-compose.yml <<'COMPOSE_FILE'
services:
  teable-sync:
    image: ghcr.io/jclee8810-max/teable-sync:latest
    ports:
      - "${PORT:-3101}:3101"
    env_file:
      - .env
    volumes:
      - teable-sync-data:/app/server/data
    restart: unless-stopped

volumes:
  teable-sync-data:
COMPOSE_FILE
docker compose pull
docker compose up -d
```

启动后访问：

```text
http://localhost:3101
```

### 局域网部署

如果要让其他电脑访问，请先确认这台服务器的局域网 IP。例如服务器 IP 是 `192.168.10.2`，复制下面整段命令到终端：

```bash
mkdir -p ~/teable-sync && cd ~/teable-sync
LAN_IP=192.168.10.2
JWT_SECRET=$(openssl rand -hex 32)
CONFIG_ENCRYPTION_KEY=$(openssl rand -hex 32)
cat > .env <<ENV_FILE
PORT=3101
SERVER_PUBLIC_URL=http://$LAN_IP:3101
FRONTEND_BASE_URL=http://$LAN_IP:3101
TEABLE_OAUTH_HOST=http://$LAN_IP:3000
JWT_SECRET=$JWT_SECRET
CONFIG_ENCRYPTION_KEY=$CONFIG_ENCRYPTION_KEY
AUTO_RESUME_TASKS=true
AUTO_RESUME_RUN_IMMEDIATELY=false
TEABLE_RATE_LIMIT_MS=120
ALERT_NOTIFICATION_SCAN_INTERVAL_MS=60000
RECONCILE_DATE_TIME_ZONE=Asia/Shanghai
LOG_LEVEL=info
ENV_FILE
cat > docker-compose.yml <<'COMPOSE_FILE'
services:
  teable-sync:
    image: ghcr.io/jclee8810-max/teable-sync:latest
    ports:
      - "${PORT:-3101}:3101"
    env_file:
      - .env
    volumes:
      - teable-sync-data:/app/server/data
    restart: unless-stopped

volumes:
  teable-sync-data:
COMPOSE_FILE
docker compose pull
docker compose up -d
```

其他电脑访问：

```text
http://192.168.10.2:3101
```

如果你的服务器 IP 不是 `192.168.10.2`，把命令里的这一行改成真实 IP：

```bash
LAN_IP=你的服务器IP
```

### 常用运维命令

进入部署目录：

```bash
cd ~/teable-sync
```

查看服务状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f teable-sync
```

升级到最新镜像：

```bash
cd ~/teable-sync
docker compose pull
docker compose up -d
```

停止服务：

```bash
cd ~/teable-sync
docker compose down
```

`teable-sync-data` 数据卷会保存账号、连接、任务、日志和配置。`docker compose down` 不会删除数据；只有主动删除 volume 才会清空数据。

## 从源码构建部署

如果你是开发者，或想自己修改代码，可以 clone 仓库后从源码构建：

```bash
cp .env.example .env
# 编辑 .env，至少修改 JWT_SECRET 和 CONFIG_ENCRYPTION_KEY
docker compose up -d --build
```

默认源码版 `docker-compose.yml` 只启动 Teable Sync 应用，不附带测试数据库。SQL 数据源和 Teable 数据源请在 Web 界面里配置。

## 局域网多人使用

如果需要其他电脑通过局域网访问，请把 `.env` 里的公开地址改成服务器 IP 或域名。例如服务器地址是 `192.168.10.2`：

```env
SERVER_PUBLIC_URL=http://192.168.10.2:3101
FRONTEND_BASE_URL=http://192.168.10.2:3101
TEABLE_OAUTH_HOST=http://192.168.10.2:3000
VITE_WS_PORT=3101
```

如果使用推荐的镜像部署，修改 `.env` 后重新部署：

```bash
docker compose up -d
```

如果使用源码构建部署，修改 `.env` 后重新部署：

```bash
docker compose up -d --build
```

局域网用户访问：

```text
http://192.168.10.2:3101
```

多人使用建议：

- 第一个注册账号会自动成为 `super_admin`。
- 管理员可以在“个人中心 -> 用户管理”调整用户角色。
- 普通用户只能看到自己的任务和可读连接；管理员可以看到全局数据。
- 连接可以设置为共享。共享连接会在前端和列表 API 中隐藏密码、Token、OAuth Secret 等敏感字段。
- 生产环境不要使用示例密钥；`CONFIG_ENCRYPTION_KEY` 设置后要稳定保存，丢失后已加密的连接密钥无法解密。

## 环境变量

| 变量 | 默认值 | 必填 | 什么时候修改 | 作用和注意事项 |
| --- | --- | --- | --- | --- |
| `PORT` | `3101` | 是 | 3101 端口被占用时 | Docker 暴露给浏览器访问的端口。改成 3200 后访问地址就是 `http://服务器IP:3200`。 |
| `VITE_WS_PORT` | `3101` | 镜像部署通常不需要 | 只有前端和后端端口不一致时 | 浏览器连接实时日志 WebSocket 的端口。Docker 部署通常保持和 `PORT` 一致。 |
| `SERVER_PUBLIC_URL` | `http://localhost:3101` | 是 | 局域网或域名访问时 | Teable Sync 对外可访问地址，用于 OAuth 回调和告警 payload。局域网多人使用时改成 `http://服务器IP:3101`。 |
| `FRONTEND_BASE_URL` | `http://localhost:3101` | 是 | 局域网或域名访问时 | 用户浏览器打开的前端地址，也是 OAuth 登录后跳回的地址。通常和 `SERVER_PUBLIC_URL` 一致。 |
| `TEABLE_OAUTH_HOST` | `http://localhost:3000` | OAuth 登录时必填 | Teable 不在本机时 | Teable 实例地址。用于“用 Teable 登录”和 OAuth 授权连接；只用手动 Token 连接时也建议填真实 Teable 地址。 |
| `TEABLE_OAUTH_CLIENT_ID` | 空 | 否 | 启用 Teable OAuth 登录时 | Teable OAuth 应用的 Client ID。只用邮箱密码登录或手动 Token 连接时可留空。 |
| `TEABLE_OAUTH_CLIENT_SECRET` | 空 | 否 | 启用 Teable OAuth 登录时 | Teable OAuth 应用的 Client Secret。属于密钥，不要公开。 |
| `JWT_SECRET` | 示例值 | 是 | 首次部署必须修改 | 用户登录 JWT 签名密钥。请使用长随机字符串；泄露后应更换并让用户重新登录。 |
| `CONFIG_ENCRYPTION_KEY` | 示例值 | 是 | 首次部署必须修改，之后不要随意改 | 用于加密保存数据库密码、Teable Token、OAuth Secret、告警 Webhook URL。丢失或更换后，旧密钥加密的数据无法解密。 |
| `AUTO_RESUME_TASKS` | `true` | 否 | 不希望重启后自动恢复任务时 | `true` 表示容器重启后恢复已启用的定时/准实时任务；`false` 表示重启后需要手动启动任务。 |
| `AUTO_RESUME_RUN_IMMEDIATELY` | `false` | 否 | 希望服务启动后立刻补跑一次时 | `false` 只恢复定时器；`true` 会在恢复后马上执行一次同步。数据量大时建议保持 `false`。 |
| `TEABLE_RATE_LIMIT_MS` | `120` | 否 | Teable 出现限流或网络抖动时 | Teable API 写入请求之间的等待时间，单位毫秒。值越大越稳但越慢。 |
| `LOG_LEVEL` | `info` | 否 | 需要排查问题或减少日志时 | 服务端日志级别，可选 `debug`、`info`、`warn`、`error`、`silent`。结构化日志会脱敏 token、password、secret、Authorization、Cookie 等字段。 |
| `TEABLE_SYNC_RUNTIME_STORE` | `sqlite` | 否 | 希望临时回退到旧 JSON 运行数据时 | 增长型运行数据存储方式。`sqlite` 会把运行历史、失败批次、审计日志写入 `runtime.sqlite`；配置、用户和密钥仍保存在 JSON。可临时设为 `json` 回退。 |
| `RUNTIME_STORE_DATA_DIR` | `/app/server/data` | 否 | 需要自定义运行数据目录时 | 运行历史、失败批次、审计日志旧 JSON 迁移源目录。Docker 部署保持默认即可。 |
| `RUNTIME_SQLITE_FILE` | `/app/server/data/runtime.sqlite` | 否 | 需要自定义 SQLite 文件位置时 | 运行时 SQLite 文件路径。Docker 部署保持默认即可，文件会落在持久化数据卷里。 |
| `INITIAL_FULL_SYNC_MAX_ROWS` | `100000` | 否 | 首次全量同步源表很大时 | 同步前预检的默认保护阈值。任务未单独配置时，首次全量预估超过该行数会阻断启动或立即同步。 |
| `INITIAL_FULL_SYNC_WARN_ROWS` | `50000` | 否 | 想更早提示大表风险时 | 同步前预检的默认提醒阈值。超过该行数但未超过上限时会提示预计分页和写入批次。 |
| `INITIALIZATION_CONCURRENCY` | `1` | 否 | 同时有多个大表首次全量同步时 | 初始化队列的并发上限。小型 Mac mini 部署建议保持 `1`，避免多个大表同时压住 Teable 和源库。旧变量名 `INITIALIZATION_QUEUE_CONCURRENCY` 仍兼容，但新部署建议使用这个变量。 |
| `INITIALIZATION_QUEUE_AVG_RUN_MINUTES` | `30` | 否 | 希望队列预计开始时间更贴近实际时 | 初始化队列用于估算排队任务预计开始时间的平均运行分钟数，只影响 UI 估算，不影响实际调度。 |
| `ALERT_NOTIFICATION_SCAN_INTERVAL_MS` | `60000` | 否 | 想更快或更慢发送告警时 | 后端扫描活跃告警并发送 Webhook 的间隔，单位毫秒。服务端最小限制为 15000。 |
| `RECONCILE_DATE_TIME_ZONE` | `Asia/Shanghai` | 否 | 业务日期不是中国时区时 | 一致性校验比较日期型字段时使用的业务时区，用于避免日期因 UTC 转换误报。 |

敏感配置保存在 `server/data/config.json`。已支持加密字段：`password`、`token`、`oauthClientSecret`、`teableOAuthToken`、`alertNotifications.webhookUrl`。

## 使用流程

### 1. 创建账号和用户

1. 打开 Web 界面。
2. 注册第一个账号，它会自动成为管理员。
3. 进入“个人中心 -> 用户管理”，按需保留普通用户或提升管理员。

### 2. 创建数据源

在“数据源”页面创建连接：

- SQL Server / MySQL / PostgreSQL：填写主机、端口、库名、用户名、密码。
- Teable：填写 Teable 地址和 Token，或使用 OAuth 授权连接。

保存后先点击“测试”。测试通过后再用于同步任务。需要多人共用时，可以由管理员或连接 owner 设置共享。

### 3. 创建同步任务

在“同步任务”页面：

1. 选择源连接和源表。
2. 选择目标 Teable 连接和目标表。
3. 配置主键/唯一键、字段映射、写入批量、分页大小、重试次数。
4. 配置“初始全量上限”。首次全量同步预估超过该行数时，后端会阻断启动，避免大表误跑。
5. 选择同步模式：手动、定时、准实时轮询或增量。
6. 选择冲突策略、删除策略和软删除字段。
7. 先执行“预检查”和“预览”，确认无阻断问题后保存。

Teable 单次写入最大 1000 条，任务里的写入批量会被限制在 10-1000 之间。建议从 500 开始，根据 Teable 响应和网络情况调整。

字段映射中，附件/图片字段支持两类稳妥同步方式：

- Teable -> Teable：Teable 原生附件数组会原样透传。
- SQL -> Teable：文本或 JSON 字段里保存的 `http/https` URL、URL 数组可转换为 Teable 附件字段。

原始二进制 BLOB、Buffer、数据库 image 类型不会直接上传到 Teable。预检和运行日志会明确提示这些字段被跳过。

### 4. 运行、校验和修复

- 手动任务：点击“运行”。
- 定时/准实时任务：点击“启动”，调度器会按配置间隔执行。
- 任务详情页可查看配置摘要、字段映射、连接状态、最近运行和失败批次。
- 一致性校验用于只读对比源端和目标端，日期型字段会按业务日期归一化后比较。
- 如果出现失败批次，可以在任务里重试或清理。

### 5. 观测告警和告警推送

“观测告警”页面汇总：

- 开放告警数量和严重级别。
- 任务健康、调度状态、最近运行结果。
- 24 小时运行次数、成功率、错误日志和警告日志。
- 最近警告/错误日志。

管理员可以点击“通知配置”启用 Webhook 告警通知：

1. 填写 Teable 自动化 Webhook URL 或其他系统的 Webhook URL。
2. 选择发送阈值：仅严重、严重和警告、全部告警。
3. 设置同一告警冷却时间，单位是分钟。
4. 点击“测试发送”确认接收端可用。

Webhook payload 包含通用字段，也包含 Teable 友好字段：

```json
{
  "source": "teable-sync",
  "event": "alert.open",
  "severity": "critical",
  "title": "任务最近运行失败",
  "message": "错误详情",
  "taskId": "...",
  "taskName": "...",
  "teable": {
    "title": "[Teable Sync] 任务最近运行失败",
    "content": "错误详情",
    "severity": "critical"
  }
}
```

Teable 收到 Webhook 后，可以用自动化把告警写入表格、发送通知或继续流转。

### 6. 配置迁移

配置迁移入口在“系统检查 -> 环境迁移”，仅 `super_admin` 可以导出、预检和导入迁移包。

这里和“配置备份”是两类功能：

- 配置备份：系统写入配置前自动生成的加密快照，用于排查和恢复，不用于跨环境迁移。
- 普通迁移包：用于跨环境迁移连接、任务、模板和告警通知配置，默认移除数据库密码、Teable Token、OAuth Secret 和告警 Webhook URL。
- 含密钥迁移包：会包含数据库密码、Teable Token、OAuth Secret 和告警 Webhook URL，只适合可信内网或离线迁移，导出前会二次确认。
- 导入迁移包：支持合并或替换当前配置；系统会先自动备份当前配置，导入后调度器会重置，自动任务默认停用。

导入后建议重新测试连接，并先手动运行关键任务，确认无误后再启动定时或准实时同步。

## 同步策略说明

### 可靠性参数

- 源分页大小：默认 `1000`，最大 `5000`。
- 写入批量：默认 `500`，范围 `10-1000`。
- 失败重试次数：默认 `3`。
- 初始全量上限：默认 `100000` 行，单个任务可在同步任务配置里调整。
- Teable 请求限流：`TEABLE_RATE_LIMIT_MS` 控制，默认 `120ms`。

源端读取优先使用主键游标分页，避免大表 `OFFSET` 翻页变慢。Teable API 对 408、409、425、429、5xx 和网络错误做退避重试。

首次全量同步前，预检会估算源表行数、源端分页数和 Teable 写入批次数。超过“初始全量上限”会阻断立即同步和自动调度启动；未超过上限但超过提醒阈值时会给出风险提示，建议在低峰期执行。

超过提醒阈值的首次全量会进入初始化队列。默认同一时间只运行 1 个大表初始化任务，其他任务显示“排队中”、队列位置和预计开始时间；需要更高并发时可调整 `INITIALIZATION_CONCURRENCY`，预计时间可用 `INITIALIZATION_QUEUE_AVG_RUN_MINUTES` 校准。

### 删除同步

删除检测只在全量扫描策略下执行：

- 忽略删除：只同步新增和更新。
- 软删除标记：源端记录消失时，把目标记录的软删除字段设为 `true`。
- 物理删除：源端记录消失时，从 Teable 删除目标记录。

物理删除不可逆，正式启用前建议先使用软删除策略验证。

### 双向同步

双向同步用于 Teable <-> Teable。常用冲突策略包括源端优先、目标端优先、最近更新时间优先和跳过冲突。

建议为参与双向同步的表配置稳定主键，并准备更新时间字段。

双向删除采用保守策略：只有配置了软删除字段，且某一侧记录已经明确标记为删除时，才会传播删除状态。单侧缺失记录默认会按“双向补齐”修复，不会直接当作删除，避免临时过滤、权限或分页异常造成误删。

- 软删除：一侧 `deleted=true` 后，把另一侧对应记录也标记为 `deleted=true`。
- 物理删除：只有检测到明确软删除标记后，才删除另一侧记录。
- 没有软删除字段时，双向任务不要启用删除策略。

## 运维和故障排查

- “日志”页面分为运行日志和操作审计。运行日志用于排查同步过程，操作审计用于查看用户、连接、任务和系统操作。
- “系统检查”会检查配置加密、数据目录写入、配置解密、备份、连接/任务引用完整性和待处理失败批次。
- 容器重启后，如果 `AUTO_RESUME_TASKS=true`，已启用的定时/准实时任务会自动恢复。
- `server/data/` 是运行数据目录，不应提交到 Git。
- `docker compose logs -f teable-sync` 可查看容器日志。
- `docker compose down` 会停止服务，但不会删除数据卷；删除数据卷会清空运行数据。

## 端到端 Smoke 验收

部署后可以运行正式上线验收：

```bash
npm run acceptance:prod
```

它会串起发布门禁、真实业务 smoke、运维硬化检查、10 万行压力模拟、故障注入验收，并在 `server/data/reports/` 生成 `production-acceptance_*.md` 报告。默认压力规模是 1 千、1 万、10 万行。

真实业务 smoke 会创建临时测试连接、任务、用户和 Teable 目标表；脚本结束时会自动清理，并在验收报告里写入测试资产清理结果。如果 Teable 表删除失败，报告会列出残留表名，方便手动处理。

验收还会非阻塞检查已发布镜像：GitHub Actions 最近一次 Docker workflow、GHCR `latest` manifest，以及本机可用时的 `docker pull ghcr.io/jclee8810-max/teable-sync:latest`。拉取默认重试 3 次，可用 `IMAGE_VERIFY_PULL_RETRIES` 调整；如果 Mac mini 到 GitHub CDN 网络抖动，可能出现 Docker pull WARN，但 Actions 和 manifest PASS 仍表示镜像已发布。如果要单独把镜像发布作为硬门禁：

```bash
IMAGE_VERIFY_STRICT=true npm run verify:image
```

如果 GitHub CDN 网络持续超时，可以运行镜像兜底检查。它会先重试拉取 GHCR 镜像，仍失败时改用本机源码构建当前镜像；需要离线搬运时可额外保存 tar 包：

```bash
npm run verify:image:fallback

IMAGE_PULL_FALLBACK_SAVE_TAR=true npm run verify:image:fallback
```

只跑较小压力规模：

```bash
ACCEPTANCE_STRESS_SIZES=1000,10000 npm run acceptance:prod
```

单独运行故障注入验收：

```bash
npm run acceptance:fault
```

它会跑 1 千、1 万、10 万行三档，模拟初始化中取消、断点继续、失败批次重放、运行历史和告警一致性，并输出 `server/data/reports/fault-injection-acceptance_*.md`。

如需在验收中真实重启当前 Docker 服务并等待健康恢复：

```bash
FAULT_DOCKER_RESTART=true npm run acceptance:fault
```

也可以单独运行 API 级端到端验收：

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

大表压力测试可以单独运行：

```bash
npm run stress:e2e
```

默认会测试 1 千、1 万、10 万行三档，覆盖首次全量、模拟取消后断点继续、重复批次幂等，并在 `server/data/reports/` 输出 Markdown 报告。它不默认并入 `npm run check:release`，避免每次发布都跑 10 万行。

只跑指定规模：

```bash
STRESS_SIZES=1000,10000 npm run stress:e2e
```

上线前运维硬化可以单独运行：

```bash
npm run audit:security
npm run backup:rehearse
npm run storage:sqlite:shadow
npm run check:onboarding
```

- `audit:security` 检查 Git remote 是否泄露 PAT、密钥是否加密保存、密钥导出是否有管理员边界、连接 DTO 是否脱敏等。
- `backup:rehearse` 把 `server/data` 中的配置、用户、历史、失败批次、checkpoint、审计日志复制到隔离目录，再按 hash 和 JSON 解析验证恢复包，不会覆盖当前运行数据。
- `storage:sqlite:shadow` 会把现有 JSON 数据生成一份 SQLite 影子库并校验行数，用于迁移验收和排查。当前 Docker 部署默认已把运行历史、失败批次和审计日志写入 `runtime.sqlite`。
- `check:onboarding` 检查 README 是否覆盖局域网部署、环境变量、数据源、任务、预检、观测告警、导入导出和验收命令。

真实长跑测试：

```bash
LONGRUN_MINUTES=60 \
LONGRUN_INTERVAL_SECONDS=60 \
LONGRUN_STRESS_SIZES=1000,10000,100000 \
npm run longrun:reliability
```

长跑会先跑发布门禁和带 Docker 重启的故障注入，然后在指定时长内循环采样健康检查、Docker 资源占用和大表压力模拟，最后再跑 API 合约和故障注入验收。报告输出到 `server/data/reports/longrun-reliability_*.md`。

真实业务链路长跑：

```bash
REALRUN_MINUTES=60 \
REALRUN_INTERVAL_SECONDS=120 \
REALRUN_E2E_TIMEOUT_MS=60000 \
npm run realrun:reliability
```

真实链路长跑会循环执行 `e2e:smoke`：使用当前共享 SQL 数据源和 Teable 连接，创建临时私有数据源、临时 Teable 表、同步任务，执行预览、同步、一致性校验、审计检查和清理；同时采样健康检查、Docker 资源和 SQLite `runtime.sqlite` 完整性。它会真实调用 SQL 和 Teable API，不默认并入发布门禁。

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

常用命令：

```bash
npm run dev
npm run build
npm start
npm run docker:up
npm run docker:down
npm run acceptance:prod
npm run acceptance:fault
npm run audit:security
npm run backup:rehearse
npm run storage:sqlite:shadow
npm run check:onboarding
npm run verify:image
npm run verify:image:fallback
npm run e2e:smoke
npm run stress:e2e
npm run longrun:reliability
npm run realrun:reliability
```
