import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


def _snapshot_json(row, item_count=None) -> dict:
    out = {
        "id": row["id"],
        "window_name": row["window_name"],
        "created_by": row["created_by"],
        "created_at": _iso(row["created_at"]),
    }
    if item_count is not None:
        out["item_count"] = item_count
    return out


def _snapshot_item_json(row) -> dict:
    return {
        "id": row["id"],
        "reading_id": row["reading_id"],
        "span_code": row["span_code"],
        "microstrain": row["microstrain"],
        "status": row["status"],
        "created_by": row["created_by"],
        "created_at": _iso(row["created_at"]),
    }


@app.post("/api/hoist-snapshots")
async def freeze_hoist_snapshot(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "观察账号仅可查看快照，不能冻结"}, status=403)
    body = request.json or {}
    window_name = str(body.get("window_name", "")).strip()
    if not window_name:
        return sanic_json({"detail": "窗口名不能为空"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO hoist_snapshots (window_name, created_by, created_at)
                VALUES (%s, %s, now())
                RETURNING id, window_name, created_by, created_at
                """,
                (window_name, user["username"]),
            )
            snap = await cur.fetchone()
            # 同一事务内把当时仍在途（候审/处理中）的读数整批抄入明细，
            # 与快照头一起提交，冻结动作与明细落库捆在一起。
            await cur.execute(
                """
                INSERT INTO hoist_snapshot_items
                    (snapshot_id, reading_id, span_code, microstrain, status,
                     created_by, created_at)
                SELECT %s, id, span_code, microstrain, status, created_by, created_at
                FROM strain_readings
                WHERE status IN ('pending', 'processing')
                ORDER BY id
                """,
                (snap["id"],),
            )
            item_count = cur.rowcount
        await conn.commit()

    return sanic_json(
        {
            **_snapshot_json(snap, item_count),
            "message": f"已冻结窗口「{window_name}」，抄入在途读数 {item_count} 笔",
        },
        status=201,
    )


@app.get("/api/hoist-snapshots")
async def list_hoist_snapshots(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT s.id, s.window_name, s.created_by, s.created_at,
                       COUNT(i.id) AS item_count
                FROM hoist_snapshots s
                LEFT JOIN hoist_snapshot_items i ON i.snapshot_id = s.id
                GROUP BY s.id
                ORDER BY s.id DESC
                """
            )
            rows = await cur.fetchall()
    return sanic_json(
        [_snapshot_json(r, item_count=r["item_count"]) for r in rows]
    )


@app.get("/api/hoist-snapshots/<snapshot_id:int>")
async def get_hoist_snapshot(request, snapshot_id: int):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, window_name, created_by, created_at
                FROM hoist_snapshots
                WHERE id = %s
                """,
                (snapshot_id,),
            )
            snap = await cur.fetchone()
            if not snap:
                return sanic_json({"detail": "快照不存在"}, status=404)
            await cur.execute(
                """
                SELECT id, reading_id, span_code, microstrain, status,
                       created_by, created_at
                FROM hoist_snapshot_items
                WHERE snapshot_id = %s
                ORDER BY id
                """,
                (snapshot_id,),
            )
            items = await cur.fetchall()
    return sanic_json(
        {
            **_snapshot_json(snap, item_count=len(items)),
            "items": [_snapshot_item_json(r) for r in items],
        }
    )
