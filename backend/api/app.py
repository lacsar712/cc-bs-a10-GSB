import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from psycopg.errors import UniqueViolation
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


def _serialize_snapshot(head, items):
    return {
        "id": head["id"],
        "window_name": head["window_name"],
        "frozen_by": head["frozen_by"],
        "frozen_at": _iso(head["frozen_at"]),
        "item_count": head["item_count"],
        "items": [
            {
                "seq": it["seq"],
                "reading_id": it["reading_id"],
                "span_code": it["span_code"],
                "microstrain": it["microstrain"],
                "status_at_freeze": it["status_at_freeze"],
                "created_by": it["created_by"],
                "created_at": _iso(it["created_at"]),
            }
            for it in items
        ],
    }


@app.post("/api/hoisting-snapshots")
async def freeze_snapshot(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "观察账号无权冻结吊装快照"}, status=403)
    body = request.json or {}
    window_name = str(body.get("window_name", "")).strip()
    if not window_name:
        return sanic_json({"detail": "吊装窗口名不能为空"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 冻结动作与明细落库必须捆在同一个事务里：
            # 任一环节失败整体回滚，不会留下没有明细的快照头。
            try:
                async with conn.transaction():
                    await cur.execute(
                        """
                        INSERT INTO hoisting_snapshots (window_name, frozen_by)
                        VALUES (%s, %s)
                        RETURNING id, window_name, frozen_by, frozen_at, item_count
                        """,
                        (window_name, user["username"]),
                    )
                    head = await cur.fetchone()
                    await cur.execute(
                        """
                        INSERT INTO hoisting_snapshot_items
                            (snapshot_id, seq, reading_id, span_code, microstrain,
                             status_at_freeze, created_by, created_at)
                        SELECT %s,
                               row_number() OVER (ORDER BY id),
                               id, span_code, microstrain, status,
                               created_by, created_at
                        FROM strain_readings
                        WHERE status IN ('pending', 'processing')
                        ORDER BY id
                        RETURNING id
                        """,
                        (head["id"],),
                    )
                    item_rows = await cur.fetchall()
                    count = len(item_rows)
                    if count == 0:
                        # 无在途读数可冻结：抛错让事务整体回滚
                        raise RuntimeError("no in-transit readings")
                    await cur.execute(
                        "UPDATE hoisting_snapshots SET item_count = %s WHERE id = %s",
                        (count, head["id"]),
                    )
                    head["item_count"] = count
                    await cur.execute(
                        """
                        SELECT seq, reading_id, span_code, microstrain,
                               status_at_freeze, created_by, created_at
                        FROM hoisting_snapshot_items
                        WHERE snapshot_id = %s
                        ORDER BY seq
                        """,
                        (head["id"],),
                    )
                    items = await cur.fetchall()
            except UniqueViolation:
                return sanic_json(
                    {"detail": "该吊装窗口名已存在，请换一个窗口名"}, status=409
                )
            except RuntimeError as exc:
                if exc.args and exc.args[0] == "no in-transit readings":
                    return sanic_json(
                        {"detail": "当前没有候审或处理中的在途读数，无法冻结"},
                        status=400,
                    )
                raise

    return sanic_json(_serialize_snapshot(head, items), status=201)


@app.get("/api/hoisting-snapshots")
async def list_snapshots(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, window_name, frozen_by, frozen_at, item_count
                FROM hoisting_snapshots
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    return sanic_json(
        [
            {
                "id": r["id"],
                "window_name": r["window_name"],
                "frozen_by": r["frozen_by"],
                "frozen_at": _iso(r["frozen_at"]),
                "item_count": r["item_count"],
            }
            for r in rows
        ]
    )


@app.get("/api/hoisting-snapshots/<snapshot_id:int>")
async def get_snapshot(request, snapshot_id: int):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, window_name, frozen_by, frozen_at, item_count
                FROM hoisting_snapshots
                WHERE id = %s
                """,
                (snapshot_id,),
            )
            head = await cur.fetchone()
            if not head:
                return sanic_json({"detail": "快照不存在"}, status=404)
            await cur.execute(
                """
                SELECT seq, reading_id, span_code, microstrain,
                       status_at_freeze, created_by, created_at
                FROM hoisting_snapshot_items
                WHERE snapshot_id = %s
                ORDER BY seq
                """,
                (snapshot_id,),
            )
            items = await cur.fetchall()
    return sanic_json(_serialize_snapshot(head, items))
