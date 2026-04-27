# TeableSync

SQL Server / MySQL / PostgreSQL → Teable 数据同步工具，带 Web GUI。

## 功能特性

| 功能 | 状态 |
|------|------|
| 多数据库支持（SQL Server / MySQL / PostgreSQL） | ✅ |
| 全量同步 + 增量同步（基于时间戳） | ✅ |
| Upsert 冲突策略（按主键更新/跳过） | ✅ |
| 自动建字段（检测源表新增列 → 自动在 Teable 创建） | ✅ |
| 字段类型映射（SQL → Teable 类型自动转换） | ✅ |
| 可视化 Web 管理界面（暗色主题） | ✅ |
| 实时同步日志（WebSocket） | ✅ |
| 定时调度（手动 / 定时） | ✅ |
| 连接测试（保存前验证连通性） | ✅ |

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

**Teable 示例**
- 类型：Teable
- URL：http://localhost:3000（或你的 Teable 地址）
- Token：你的 Teable API Token

### 4. 创建同步任务

1. 选择源连接 → 选择源表
2. 选择目标连接 → 选择目标表
3. 配置字段映射（自动检测主键和时间戳列）
4. 选择同步模式（手动 / 定时）和冲突策略（Upsert / Skip）
5. 保存并手动触发一次同步

### 5. 启动服务

```bash
npm run dev
# → 后端：http://localhost:3100
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

### Docker 部署（待实现）

```bash
docker build -t teable-sync .
docker run -p 3100:3100 -p 5173:5173 teable-sync
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

### 自动建字段
- 同步时检测源表新增列
- 自动在 Teable 目标表创建对应字段
- 已配置的字段映射优先，不会重复创建

## API 接口

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
| WS | ws://localhost:3100 | 实时日志推送 |

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