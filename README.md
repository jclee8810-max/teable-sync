# TeableSync

SQL Server / MySQL / PostgreSQL → Teable 数据同步工具，带 Web GUI。

## 功能特性

| 功能 | 状态 |
|------|------|
| 多数据库支持（SQL Server / MySQL / PostgreSQL） | ✅ |
| 全量同步 + 增量同步（基于时间戳） | ✅ |
| Upsert 冲突策略（按主键更新/跳过） | ✅ |
| 分页读取 + 批量写入 + 失败重试/限流 | ✅ |
| 删除同步（忽略 / 软删除 / 物理删除） | ✅ |
| 自动建字段（检测源表新增列 → 自动在 Teable 创建） | ✅ |
| 字段类型映射（SQL → Teable 类型自动转换） | ✅ |
| 可视化 Web 管理界面（暗色主题） | ✅ |
| 实时同步日志（WebSocket） | ✅ |
| 定时调度（手动 / 定时） | ✅ |
| 连接测试（保存前验证连通性） | ✅ |
| 配置密钥加密存储 | ✅ |
| Teable OAuth 2.0 授权连接 | ✅ |
| OAuth 单点登录（用 Teable 账号登录） | ✅ |
| 用户认证（JWT + 密码加密） | ✅ |

## 系统要求

- Node.js >= 18
- SQL Server / MySQL / PostgreSQL（任选其一）
- Teable 实例（自部署 or 官方云版）

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/jclee8810/teable-sync.git
cd teable-sync
```

### 2. 安装依赖

```bash
# 根目录
npm install

# 后端
cd server && npm install && cd ..

# 前端
cd client && npm install && cd ..
```

### 3. 配置连接

启动服务后，打开 http://localhost:5173

在 **连接管理** 面板添加数据源：

**SQL Server 示例**
- 类型：SQL Server
- Host：localhost（或 192.168.x.x）
- Port：1433
- 数据库：你的数据库名
- 用户名：sa
- 密码：your_password

**Teable 示例（手动 Token）**
- 类型：Teable
- URL：http://localhost:3000（或你的 Teable 地址）
- Token：你的 Teable API Token

**Teable OAuth 连接（推荐）**
- 类型：Teable
- URL：你的 Teable 地址
- 点击「OAuth 连接 Teable 账号」，按提示完成授权
- 无需手动输入 Token，更安全

### 4. 创建同步任务

1. 选择源连接 → 选择源表
2. 选择目标连接 → 选择目标表
3. 配置字段映射（自动检测主键和时间戳列）
4. 选择同步模式（手动 / 定时）、冲突策略（Upsert / Skip）和可靠性参数
5. 保存并手动触发一次同步

### 5. 启动服务

```bash
npm run dev
# → 后端：http://localhost:3101
# → 前端：http://localhost:5173
```

## 部署

### 开发环境（本地）

```bash
npm run dev
```

### 生产环境

```bash
# 构建前端
npm run build

# 启动后端
cd server && npm start
```

### Docker 部署（一键启动）

```bash
# 克隆项目
git clone https://github.com/jclee8810/teable-sync.git
cd teable-sync

# 启动全部服务（TeableSync + SQL Server）
docker-compose up -d

# 打开浏览器
open http://localhost:5173
```

> 提示：docker-compose.yml 默认包含 TeableSync + SQL Server（测试用）。如需 Teable 自部署版，取消注释文件底部的 Teable + PostgreSQL 部分。

### 生产环境镜像构建

```bash
# 构建镜像
npm run docker:build

# 运行
docker run -d -p 3101:3101 --name teable-sync teable-sync
```

### Docker Compose 各服务说明

| 服务 | 端口 | 说明 |
|------|------|------|
| teable-sync | 3101 | 主服务 |
| sqlserver | 1433 | SQL Server（可选，测试用）|

如外部已有 SQL Server 或 Teable，修改 `docker-compose.yml` 中对应地址后重启即可。

### 端到端 Smoke 验收

部署后可以运行一条 API 级端到端验收，模拟管理员和普通用户完成权限检查、共享连接读取、私有数据源创建、任务创建、预览、手动同步、一致性校验、审计和备份检查。

```bash
npm run e2e:smoke
```

验收脚本在 `teable-sync` 容器内执行，默认访问 `http://127.0.0.1:3101/api`，并读取容器内 `/app/server/data/config.json` 和 `users.json`。脚本只创建 `codex-e2e-*` 临时用户、连接、任务和 Teable 测试表；任务和连接会在结束时软删除，Teable 测试表保留用于人工复查。

可选环境变量：

```bash
E2E_API_BASE=http://127.0.0.1:3101/api \
E2E_TEABLE_BASE_HINT=SyncPilot \
E2E_RUN_TIMEOUT_MS=30000 \
npm run e2e:smoke
```

## 字段类型映射

| SQL 类型 | Teable 类型 |
|----------|-------------|
| varchar / nvarchar / text | singleLineText |
| int / bigint / smallint | number |
| datetime / timestamp / date | dateTime |
| bit / boolean | checkbox |
| decimal / float / real | number |
| nvarchar(max) / text | longText |

## 同步策略说明

### 增量同步
- 基于时间戳列（默认自动检测 `updated_at`）
- 每次同步后记录 `lastSyncAt`
- 再次同步时只拉取 `updated_at > lastSyncAt` 的记录

### 冲突策略
- **Upsert**：主键冲突时更新现有记录，不重复插入
- **Skip**：主键冲突时跳过该记录

### 可靠性参数
- **源分页大小**：每次从源数据库读取的行数，默认 1000，最大 5000
- **写入批量**：每次写入 Teable 的记录数，默认 500，最大 1000
- **失败重试次数**：源读取、Teable 读取和批量写入失败时的重试次数，默认 3
- 源端读取优先使用主键游标分页，避免大表 `OFFSET` 越翻越慢，也降低同步过程中源表变化导致跳页的风险
- Teable API 请求内置退避重试，默认对 408 / 409 / 425 / 429 / 5xx 和网络错误重试
- `TEABLE_RATE_LIMIT_MS` 可控制 Teable 请求间隔，默认 120ms

### 删除同步
- **不处理删除**：默认策略，只同步新增和更新
- **软删除标记**：源端记录消失时，将 Teable 目标记录的软删除字段标记为 `true`
- **从 Teable 删除**：源端记录消失时，直接删除 Teable 目标记录
- 删除检测只在 **全量扫描** 策略下执行。时间戳、rowversion、自增主键等增量策略无法可靠判断源端删除，因此会自动跳过删除检测。
- 使用软删除前，请确认目标表存在对应字段，默认字段名为 `deleted`。

### 自动建字段
- 同步时检测源表新增列
- 自动在 Teable 目标表创建对应字段
- 已配置的字段映射优先，不会重复创建

## 用户认证

### 登录方式

1. **邮箱密码登录** — 注册账号后直接登录
2. **Teable OAuth 登录** — 点击「用 Teable 账号登录」按钮，跳转到 Teable 授权页面，授权后自动创建账号并登录

### 用户角色

| 角色 | 权限 |
|------|------|
| super_admin | 所有权限 + 用户管理（第一个注册的用户自动成为管理员） |
| user | 正常使用权限 |

### OAuth 单点登录流程

```
1. 用户点击「用 Teable 账号登录」
2. 浏览器跳转到 Teable 授权页面
3. 用户在 Teable 登录并授权
4. Teable 回调 → sync-pilot 后端用 code 换 access_token
5. 自动创建/匹配 sync-pilot 用户 → 签发 JWT
6. 重定向回前端，自动登录完成
```

### OAuth 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| TEABLE_OAUTH_HOST | http://localhost:3000 | Teable 实例地址 |
| SERVER_PUBLIC_URL | http://localhost:3101 | 服务器公网地址（OAuth 回调用）|
| FRONTEND_BASE_URL | http://localhost:3101 | 前端访问地址 |
| TEABLE_OAUTH_CLIENT_ID | - | OAuth App Client ID |
| TEABLE_OAUTH_CLIENT_SECRET | - | OAuth App Client Secret |
| PORT | 3100 | 后端端口 |

### 配置和密钥存储

连接配置仍保存在 `server/data/config.json`，但敏感字段会在保存时加密：

- 数据库密码：`password`
- Teable Token：`token`
- OAuth Client Secret：`oauthClientSecret`
- Teable OAuth Token：`teableOAuthToken`

生产环境建议显式设置：

```bash
CONFIG_ENCRYPTION_KEY=请生成32字节以上随机字符串
JWT_SECRET=请生成32字节以上随机字符串
TEABLE_RATE_LIMIT_MS=120
```

如果未设置 `CONFIG_ENCRYPTION_KEY`，系统会使用 `JWT_SECRET` 派生加密密钥；如果两者都未设置，则为兼容旧部署继续明文保存。加密密钥必须长期备份，密钥丢失或更换后，已加密的连接密码和 Token 将无法解密。

## 客户部署指南

### 局域网/内网部署

TeableSync 已支持局域网访问，客户可从内网任意设备访问。

**1. 环境变量配置**

```bash
# server/.env
PORT=3101
SERVER_PUBLIC_URL=http://192.168.10.2:3101  # 服务器在局域网的地址
FRONTEND_BASE_URL=http://localhost:3101
TEABLE_OAUTH_HOST=http://your-teable:3000    # Teable 实例地址
JWT_SECRET=请生成32字节随机字符串
CONFIG_ENCRYPTION_KEY=请生成32字节以上随机字符串
TEABLE_RATE_LIMIT_MS=120
```

**2. 启动服务**

```bash
# 构建前端
cd client && npm run build && cd ..

# 启动后端
cd server && npm start
```

**3. 客户访问**

- 前端：`http://192.168.10.2:3101`
- 后端 API：`http://192.168.10.2:3101`

### Docker 部署（推荐）

```bash
# 构建镜像
docker build -t teable-sync .

# 运行容器
docker run -d -p 3101:3101 \
  -e PORT=3101 \
  -e SERVER_PUBLIC_URL=http://your-server:3101 \
  -e FRONTEND_BASE_URL=http://localhost:3101 \
  -e TEABLE_OAUTH_HOST=http://your-teable:3000 \
  -e JWT_SECRET=your-random-secret \
  -e CONFIG_ENCRYPTION_KEY=your-random-config-key \
  -e TEABLE_RATE_LIMIT_MS=120 \
  -v /path/to/data:/app/server/data \
  --name teable-sync \
  teable-sync
```

### Nginx 反向代理（公网部署）

```nginx
server {
    listen 80;
    server_name sync.yourcompany.com;

    # 前端静态文件
    location / {
        root /path/to/teable-sync/client/dist;
        try_files $uri $uri/ /index.html;
    }

    # 后端 API
    location /api {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**环境变量：**

```bash
SERVER_PUBLIC_URL=https://sync.yourcompany.com
FRONTEND_BASE_URL=http://localhost:3101
CONFIG_ENCRYPTION_KEY=your-random-config-key
```

## API 接口

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/register | 注册 |
| POST | /api/auth/login | 登录 |
| GET | /api/auth/me | 获取当前用户信息 |
| PUT | /api/auth/password | 修改密码 |
| GET | /api/auth/users | 获取用户列表（管理员） |
| DELETE | /api/auth/users/:id | 删除用户（管理员） |
| GET | /api/auth/teable-login | Teable OAuth 登录（302 重定向） |
| GET | /api/auth/teable-callback | OAuth 回调端点 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/connections | 获取所有连接 |
| POST | /api/connections | 创建连接 |
| PUT | /api/connections/:id | 更新连接 |
| DELETE | /api/connections/:id | 删除连接 |
| POST | /api/connections/:id/test | 测试连接 |
| GET | /api/connections/:id/tables | 获取数据库表和字段 |
| GET | /api/teable/bases | 获取 Teable Base 列表 |
| GET | /api/teable/tables/:id/fields | 获取 Teable 表字段 |
| GET | /api/tasks | 获取同步任务 |
| POST | /api/tasks | 创建任务 |
| PUT | /api/tasks/:id | 更新任务 |
| DELETE | /api/tasks/:id | 删除任务 |
| POST | /api/tasks/:id/run | 手动执行同步 |
| GET | /api/logs | 获取日志 |
| DELETE | /api/logs | 清空日志 |
| POST | /api/oauth/teable/start | 发起 OAuth 授权 |
| GET | /api/oauth/teable/callback | OAuth 回调（Teable 跳转回来） |
| GET | /api/oauth/teable/status/:id | 查询 OAuth 连接状态 |
| DELETE | /api/oauth/teable/disconnect/:id | 断开 OAuth 连接 |
| POST | /api/oauth/teable/app | 在 Teable 创建 OAuth 应用 |
| WS | `ws://[host]:${PORT}` | 实时日志推送 |

### OAuth 连接管理（数据源授权）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/oauth/teable/start | 发起 OAuth 授权（数据源连接） |
| GET | /api/oauth/teable/callback | OAuth 回调（数据源连接） |
| GET | /api/oauth/teable/status/:id | 查询连接状态 |
| DELETE | /api/oauth/teable/disconnect/:id | 断开连接 |

## 目录结构

```
teable-sync/
├── package.json          # 并行启动 server + client
├── server/
│   ├── package.json
│   └── src/
│       ├── index.js          # Express 入口
│       ├── services/
│       │   ├── dbService.js      # 数据库统一接口
│       │   ├── teableService.js  # Teable API 封装
│       │   └── syncEngine.js     # 同步引擎
│       └── data/                # 配置和状态持久化
└── client/
    ├── package.json
    └── src/
        ├── App.vue
        ├── api.js
        └── components/
            ├── ConnectionsPanel.vue
            ├── TasksPanel.vue
            └── LogsPanel.vue
```

## 常见问题

### Q: 增量同步拉取 0 条记录？
A: 检查时间戳列的值。如果 `lastSyncAt` 比源表所有记录的 `updated_at` 都新，会拉取不到数据。可删除 `server/data/sync-state/` 下的状态文件强制全量同步。

### Q: 怎么查看同步日志？
A: Web UI 底部有实时日志面板，支持按 Info/Warn/Error 过滤。

### Q: 支持 Teable Cloud（app.teable.ai）吗？
A: 支持，只需在连接配置时填入你的 Teable Cloud 地址和 Token。

### Q: OAuth 连接有什么好处？
A: OAuth 是 Teable 官方推荐的授权方式，比手动输入 Token 更安全，无需暴露管理员密码，且 Token 自动续期。

### Q: OAuth 需要哪些条件？
A: 需要你部署的 Teable 实例支持 OAuth（Teable 自部署版 1.8+），以及具有管理员权限的账号来创建 OAuth 应用。

### Q: OAuth 连接失败怎么办？
FRONTEND_BASE_URL=http://localhost:3101
