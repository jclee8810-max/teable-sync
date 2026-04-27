# 更新日志

## v1.0.0 (2026-04-27)

### 新增
- **Docker 部署支持** — 添加 Dockerfile 和 docker-compose.yml，一键启动 TeableSync + SQL Server 测试环境
- **多数据库支持** — SQL Server / MySQL / PostgreSQL 连接管理
- **全量同步** — 首次同步拉取源表全部记录
- **增量同步** — 基于时间戳列（updated_at）只同步新/改动的记录
- **Upsert 冲突策略** — 主键冲突时更新现有记录，不重复插入
- **Skip 冲突策略** — 主键冲突时跳过该记录
- **自动建字段** — 检测源表新增列，自动在 Teable 目标表创建对应字段
- **字段类型映射** — SQL 类型自动转换为 Teable 类型
- **可视化 Web 管理界面** — 暗色主题仪表盘
- **实时同步日志** — WebSocket 推送，Web UI 底部面板显示
- **定时调度** — 支持手动触发或定时同步
- **连接测试** — 保存前验证数据源连通性

### 初始版本
- TeableSync MVP 核心同步引擎
- Web GUI（连接管理 / 同步任务 / 日志面板）
- API 接口完整实现