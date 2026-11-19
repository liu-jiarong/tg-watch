"""监听 Telegram 群消息，按页面维护的规则记录，并提供日志阅览页面。

    python chat.py --login        首次使用：登录 Telegram
    python chat.py --password     设置或修改页面访问密码（服务运行时也可修改）
    python chat.py                启动监听和页面
"""

import argparse
import asyncio
import base64
import getpass
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Literal
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from telethon import TelegramClient, events, utils
from telethon.tl.types import PeerChannel

from chat_store import BJ_TZ, Store, iso_time

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "chat_data"
STATIC_DIR = BASE_DIR / "static"
SESSION_NAME = str(BASE_DIR / "chat")
API_ID = 11176962
API_HASH = "fb6113c824a9a0d593be9869cd3b332f"
WEB_HOST = "0.0.0.0"
WEB_PORT = 8000

WATCH_GROUPS = {
    "云极": "YJiSpa",
    "水果": "SGQQGZ",
    "igc": "InvictusGmerChill",
    "自由": -3500688532,
}

REPORT_KEYWORDS = ("Ty报告指南", "YJ报告指南")
DINGTALK_SECRET = "SEC2b33b7923430093ef2b9087aabb594b107239ce8d1035eaadbfae5a47897a978"
DINGTALK_TOKEN = "6a0fb458152d7f457cd9304f946e6e0d36acfb4adc2334c9a52ded24ceac86cf"


# ---- 匹配规则 ----


def contains_keyword(text, keywords):
    """纯数字关键词按完整数字匹配（36 不命中 136），其余按子串匹配，区分大小写。"""
    return any(
        re.search(rf"(?<!\d){re.escape(keyword)}(?!\d)", text) if keyword.isdecimal()
        else keyword in text
        for keyword in keywords
    )


def sent_by(rules, sender_id):
    """用户规则只按数字 ID 匹配，过滤时不需要读取发送者资料。"""
    return any(int(rule["value"]) == sender_id for rule in rules)


def should_record(rules, text, sender_id):
    """屏蔽用户和屏蔽词优先，其次命中关注词或来自关注用户。"""
    if sent_by(rules["block"], sender_id) or contains_keyword(
        text, (rule["value"] for rule in rules["ignore"])
    ):
        return False
    return contains_keyword(text, (rule["value"] for rule in rules["watch"])) or sent_by(
        rules["user"], sender_id
    )


# ---- 运行时状态 ----

monitor = {"detail": "", "storage_error": ""}  # 页面轮询时原样展示，为空表示正常
report_period = None  # 已发过报告通知的周期


# ---- 钉钉通知 ----


def send_dingtalk(content):
    timestamp = str(round(time.time() * 1000))
    signature = base64.b64encode(
        hmac.new(
            DINGTALK_SECRET.encode(),
            f"{timestamp}\n{DINGTALK_SECRET}".encode(),
            digestmod=hashlib.sha256,
        ).digest()
    ).decode("ascii")
    query = urlencode(
        {"access_token": DINGTALK_TOKEN, "timestamp": timestamp, "sign": signature}
    )
    request = UrlRequest(
        f"https://oapi.dingtalk.com/robot/send?{query}",
        data=json.dumps(
            {"msgtype": "text", "text": {"content": content}}, ensure_ascii=False
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        result = json.load(response)
    if result.get("errcode") != 0:
        raise RuntimeError(f"钉钉机器人返回失败：{result!r}")


async def notify_daily_report(text):
    global report_period
    if not all(keyword in text for keyword in REPORT_KEYWORDS):
        return
    # 北京时间 08:00 切换周期；凌晨仍属于前一天的周期，重启后允许重发。
    period = (datetime.now(BJ_TZ) - timedelta(hours=8)).date().isoformat()
    if report_period == period:
        return
    try:
        await asyncio.to_thread(send_dingtalk, "dq")
    except Exception:
        # 失败不占用本周期的通知机会，后续匹配消息可再次尝试。
        logging.exception("报告指南钉钉通知失败")
    else:
        report_period = period


# ---- Telegram 监听 ----


async def handle_message(event, action, group_name, store):
    text = event.raw_text
    if not text:
        return
    # 报告通知只看报告关键词，不受页面维护的记录规则影响；放在前面，记录出错也不影响通知。
    await notify_daily_report(text)
    # 每条消息都读取最新规则，页面修改后立即生效，不需要缓存和同步。
    if not should_record(await asyncio.to_thread(store.rules), text, event.sender_id):
        return
    # Telegram 生成链接预览等情况也会推送编辑事件，但正文没变、也没有 edit_date。
    # 只有用户编辑过，且正文与这条消息上次记录的不同，才追加为新的编辑记录。
    if action == "EDIT" and (
        event.edit_date is None
        or text == await asyncio.to_thread(store.last_text, event.chat_id, event.id)
    ):
        return

    # 只有确定要记录的消息才读取发送者资料，用于显示名称；匿名管理员等情况下 sender 为 None。
    sender = await event.get_sender()
    username = getattr(sender, "username", None)
    name = utils.get_display_name(sender) or username or str(event.sender_id or "未知用户")
    sent_at = iso_time(event.date)
    edited_at = iso_time(event.edit_date) if action == "EDIT" else None
    print("=" * 80)
    print(f"{name} chat={group_name} [{action}] sent={sent_at}"
          + (f" edited={edited_at}" if edited_at else ""))
    print(text, flush=True)

    try:
        await asyncio.to_thread(
            store.append,
            {
                "action": action,
                "group_name": group_name,
                "chat_id": event.chat_id,
                "message_id": event.id,
                "sender": name,
                "sender_id": event.sender_id,
                "sender_username": username,
                "text": text,
                "sent_at": sent_at,
                "edited_at": edited_at,
            },
        )
    except Exception as exc:
        monitor["storage_error"] = f"日志保存失败：{exc}"
        logging.exception("日志保存失败")
    else:
        monitor["storage_error"] = ""


async def resolve_group(client, group_name, target):
    candidates = [target]
    if isinstance(target, int):
        # Web 群 ID 可能对应普通群或超级群，保留频道类型的解析。
        candidates.append(PeerChannel(abs(target)))
    errors = []
    for candidate in candidates:
        try:
            return await client.get_entity(candidate)
        except Exception as exc:
            errors.append(f"{candidate!r}: {exc}")
    detail = "\n".join(f"  - {error}" for error in errors)
    raise RuntimeError(
        f"无法解析群“{group_name}”({target})。请确认当前账号已加入该群，"
        f"或改用用户名、邀请链接或 -100 开头的群 ID。\n已尝试:\n{detail}"
    )


async def monitor_telegram(store):
    # 串行处理更新：日志编号与接收顺序一致，编辑去重的先查后写也不会交错。
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH, sequential_updates=True)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise RuntimeError(
                "Telegram 尚未登录，请先运行 python chat.py --login 完成登录，再重启服务。"
            )
        errors = []
        print("开始监听:")
        for group_name, target in WATCH_GROUPS.items():
            try:
                entity = await resolve_group(client, group_name, target)
            except RuntimeError as exc:
                errors.append(str(exc))
                logging.warning("%s", exc)
                continue
            for action, event_type in (("NEW", events.NewMessage), ("EDIT", events.MessageEdited)):
                client.add_event_handler(
                    partial(handle_message, action=action, group_name=group_name, store=store),
                    event_type(chats=entity),
                )
            print(f" - {group_name} ({getattr(entity, 'title', None) or group_name})")

        if len(errors) == len(WATCH_GROUPS):
            raise RuntimeError("未能监听任何群。\n" + "\n".join(errors))
        if errors:
            monitor["detail"] = "部分群未能监听：\n" + "\n".join(errors)
        await client.run_until_disconnected()
        monitor["detail"] = "Telegram 连接已断开，请重启服务恢复监听。"
    except Exception as exc:
        monitor["detail"] = str(exc)
        logging.exception("Telegram 监听停止，已保存的日志仍可在页面查看")
    finally:
        with suppress(Exception):
            await client.disconnect()


async def login():
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
    try:
        await client.start()
        print("Telegram 登录完成，运行 python chat.py 启动监听和页面。")
    finally:
        await client.disconnect()


# ---- 访问密码 ----
# 数据库只存加盐的 scrypt 哈希。登录 Cookie 是“过期时间.签名”，签名以密码哈希为密钥：
# 每次设置密码都会换新盐、得到新哈希，之前登录的设备随之失效。

COOKIE_NAME = "chat_session"
SESSION_SECONDS = 30 * 24 * 3600
MIN_PASSWORD_LENGTH = 6
LOGIN_LIMIT = 10  # 同一来源在 LOGIN_WINDOW 秒内最多尝试的次数，防止暴力猜密码
LOGIN_WINDOW = 15 * 60


def scrypt(password, salt):
    return hashlib.scrypt(
        password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32
    ).hex()


def sign(auth, expires):
    return hmac.new(bytes.fromhex(auth["hash"]), expires.encode(), hashlib.sha256).hexdigest()


# ---- Web ----

MAX_RULE_LENGTH = 64  # 与页面备注输入框的 maxlength 一致


class LoginInput(BaseModel):
    password: str = Field(max_length=200)


class TagInput(BaseModel):
    log_id: int


class RuleInput(BaseModel):
    kind: Literal["watch", "ignore", "user", "block"]
    values: list[str] = Field(max_length=500)
    note: str = ""


def create_app(store):
    @asynccontextmanager
    async def lifespan(application):
        task = asyncio.create_task(monitor_telegram(store))
        try:
            yield
        finally:
            # monitor_telegram 自行处理所有异常，等待被取消的任务只会抛出 CancelledError。
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    # 关闭自动生成的接口文档，页面和静态资源之外只暴露需要登录的 /api。
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    attempts = {}  # 来源 -> 时间窗口内的登录尝试时刻，登录成功后清除

    @app.middleware("http")
    async def revalidate_assets(request: Request, call_next):
        # 页面和静态资源每次都向服务端确认（静态资源未修改时返回 304），重启后不会用缓存的旧脚本读新接口。
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    # serve() 在没有密码时不会启动，密码记录只会被替换不会被删除，所以这里总能读到。
    @app.middleware("http")
    async def require_login(request: Request, call_next):
        # 每次从数据库读取密码记录，命令行修改密码后旧的登录立即失效。
        if request.url.path.startswith("/api/") and request.url.path != "/api/login":
            auth = await asyncio.to_thread(store.auth)
            expires, _, signature = request.cookies.get(COOKIE_NAME, "").partition(".")
            # 先验签名：通过的 expires 一定是服务端生成的数字，伪造的 Cookie 不会让 int() 抛错；
            # 按字节比较，签名含非 ASCII 字符时 compare_digest 也不会抛错。
            if not (
                hmac.compare_digest(signature.encode(), sign(auth, expires).encode())
                and int(expires) > time.time()
            ):
                return JSONResponse({"detail": "请先登录。"}, status_code=401)
        return await call_next(request)

    @app.post("/api/login")
    async def page_login(body: LoginInput, request: Request, response: Response):
        client = request.client.host if request.client else ""
        now = time.monotonic()
        recent = [moment for moment in attempts.get(client, ()) if moment > now - LOGIN_WINDOW]
        if len(recent) >= LOGIN_LIMIT:
            raise HTTPException(429, f"尝试次数过多，请 {LOGIN_WINDOW // 60} 分钟后再试。")
        # 校验密码前先计入，同时发出的多个请求也逐个计数，不能绕过次数限制。
        attempts[client] = [*recent, now]
        auth = await asyncio.to_thread(store.auth)
        digest = await asyncio.to_thread(scrypt, body.password, auth["salt"])
        if not hmac.compare_digest(digest, auth["hash"]):
            raise HTTPException(401, "密码不正确。")
        attempts.pop(client, None)
        expires = str(int(time.time()) + SESSION_SECONDS)
        response.set_cookie(
            COOKIE_NAME,
            f"{expires}.{sign(auth, expires)}",
            max_age=SESSION_SECONDS,
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
        return {"ok": True}

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/status")
    def status():
        return {**store.summary(), "monitor": monitor, "rules": store.rules()}

    @app.get("/api/logs")
    def logs(before: int | None = None, after: int | None = None, anchor: int | None = None):
        return store.page(before=before, after=after, anchor=anchor)

    @app.put("/api/tag")
    def set_tag(body: TagInput):
        return store.set_tag(body.log_id)

    @app.post("/api/rules")
    def add_rules(body: RuleInput):
        values = [value.strip() for value in body.values if value.strip()]
        note = body.note.strip()
        if not values:
            raise HTTPException(400, "请输入要添加的内容。")
        if any(len(value) > MAX_RULE_LENGTH for value in values) or len(note) > MAX_RULE_LENGTH:
            raise HTTPException(400, f"每项最多 {MAX_RULE_LENGTH} 个字符。")
        if body.kind in ("user", "block") and not all(
            re.fullmatch(r"-?[0-9]+", value) for value in values
        ):
            raise HTTPException(400, "用户只能填数字 ID，点击消息上的发送者可自动填入。")
        added = store.add_rules(body.kind, values, note)
        return {"added": added, "rules": store.rules()}

    @app.delete("/api/rules/{rule_id}")
    def delete_rule(rule_id: int):
        # 规则已被其他设备删除时结果相同，直接返回最新规则。
        store.delete_rule(rule_id)
        return {"rules": store.rules()}

    return app


def set_password():
    password = getpass.getpass("新的页面访问密码：")
    if len(password) < MIN_PASSWORD_LENGTH:
        print(f"密码至少 {MIN_PASSWORD_LENGTH} 位，未修改。")
        return
    if getpass.getpass("再输入一次：") != password:
        print("两次输入不一致，未修改。")
        return
    salt = secrets.token_hex(16)
    Store(DATA_DIR).set_auth({"salt": salt, "hash": scrypt(password, salt)})
    print("访问密码已设置，之前登录的设备需要重新登录。")


def serve():
    store = Store(DATA_DIR)
    if store.auth() is None:
        print("尚未设置页面访问密码，请先运行 python chat.py --password。")
        return
    # 端口固定，重复启动的进程会因端口占用退出，数据目录只由一个服务进程写入。
    # uvicorn 先启动 lifespan 再绑定端口，所以它退出前会短暂连接 Telegram，通常来不及注册监听。
    uvicorn.run(create_app(store), host=WEB_HOST, port=WEB_PORT)


def main():
    parser = argparse.ArgumentParser(description="Telegram 群消息监听与阅览")
    parser.add_argument("--login", action="store_true", help="登录 Telegram 后退出")
    parser.add_argument("--password", action="store_true", help="设置或修改页面访问密码")
    args = parser.parse_args()
    try:
        if args.login:
            asyncio.run(login())
        elif args.password:
            set_password()
        else:
            serve()
    except KeyboardInterrupt:
        print("已退出")


if __name__ == "__main__":
    main()
