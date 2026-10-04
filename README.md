# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 吊装快照

吊装窗口内可把在途读数冻结成窗口快照供监理复查：顶栏「吊装快照」进入专页，含 **窗口名输入**、**历史清单**、**快照明细** 三块。

- 写权限员（surveyor）填窗口名后「一键冻结」，把当时仍 **候审/处理中** 的跨段微应变整批抄进快照；快照头与明细在 **同一事务** 落库。
- 观察账号（reviewer）可翻历史清单与明细，不能冻结（前端禁用 + 接口 403）。
- 快照行是冻结当时的拷贝，读数后续办结不回改，重开快照行数不少。

| 接口 | 说明 |
|------|------|
| `POST /api/hoist-snapshots` | 冻结窗口快照（仅写权限），body `{"window_name": "..."}` |
| `GET /api/hoist-snapshots` | 历史清单（含在途笔数），登录即可 |
| `GET /api/hoist-snapshots/{id}` | 快照明细，登录即可 |

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
