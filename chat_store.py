"""SQLite 存储：按接收顺序编号的日志、页面维护的规则，以及唯一的阅读 Tag。

所有时间都存为带时区的北京时间 ISO 8601 字符串，例如 2026-11-16T20:30:00+08:00。
"""

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

PAGE_SIZE = 100
ANCHOR_CONTEXT = 30  # 跳到 Tag 时，Tag 及之前保留的条数，其余用于后续新消息。
RULE_KINDS = ("watch", "ignore", "user", "block")
BJ_TZ = timezone(timedelta(hours=8))

RULES_TABLE = """
CREATE TABLE IF NOT EXISTS {name} (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('watch', 'ignore', 'user', 'block')),
    value TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (kind, value)
);
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('NEW', 'EDIT')),
    group_name TEXT NOT NULL,
    chat_id INTEGER,
    message_id INTEGER,
    sender TEXT NOT NULL,
    sender_id INTEGER,
    sender_username TEXT,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    edited_at TEXT,
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_message ON logs (chat_id, message_id);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
""" + RULES_TABLE.format(name="rules")


def iso_time(dt):
    return dt.astimezone(BJ_TZ).isoformat(timespec="seconds")


def now_iso():
    return iso_time(datetime.now(BJ_TZ))


class Store:
    """存储与进程同生命周期：数据库连接在进程退出时释放，不需要显式关闭。"""

    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(directory / "chat.db", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.executescript(SCHEMA)
        self._migrate_rules()

    def _migrate_rules(self):
        """早期的规则表约束不含屏蔽用户。SQLite 不能修改约束，只能在一个事务里建新表、复制后替换。"""
        (sql,) = self._db.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rules'"
        ).fetchone()
        if "'block'" in sql:
            return
        self._db.executescript(
            "BEGIN;"
            + RULES_TABLE.format(name="rules_new")
            + "INSERT INTO rules_new (id, kind, value, note, created_at) "
            "SELECT id, kind, value, note, created_at FROM rules;"
            "DROP TABLE rules;"
            "ALTER TABLE rules_new RENAME TO rules;"
            "COMMIT;"
        )

    # ---- 元数据 ----

    def _meta(self, key):
        row = self._db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None

    def _set_meta(self, key, value):
        self._db.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )

    # ---- 日志 ----

    def append(self, record):
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO logs (action, group_name, chat_id, message_id, sender, sender_id, "
                "sender_username, text, sent_at, edited_at, recorded_at) VALUES (:action, :group_name, "
                ":chat_id, :message_id, :sender, :sender_id, :sender_username, :text, :sent_at, "
                ":edited_at, :recorded_at)",
                {**record, "recorded_at": now_iso()},
            )

    def last_text(self, chat_id, message_id):
        """同一条 Telegram 消息最近一次记录的正文；没有记录过时返回 None。"""
        with self._lock:
            row = self._db.execute(
                "SELECT text FROM logs WHERE chat_id = ? AND message_id = ? "
                "ORDER BY id DESC LIMIT 1",
                (chat_id, message_id),
            ).fetchone()
            return row["text"] if row else None

    def _select(self, where, params, order, limit):
        rows = self._db.execute(
            f"SELECT * FROM logs WHERE {where} ORDER BY id {order} LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def _exists(self, where, params):
        return bool(self._db.execute(f"SELECT 1 FROM logs WHERE {where} LIMIT 1", params).fetchone())

    def page(self, before=None, after=None, anchor=None):
        """返回按 id 升序的一页日志，以及这一页之前是否还有记录。"""
        with self._lock:
            if anchor is not None:
                # 之后的新消息最多占去 ANCHOR_CONTEXT 以外的位置，剩下的用 Tag 及之前的记录补满。
                head = self._select("id <= ?", (anchor,), "DESC", PAGE_SIZE)
                tail = self._select(
                    "id > ?", (anchor,), "ASC", PAGE_SIZE - min(len(head), ANCHOR_CONTEXT)
                )
                items = head[: PAGE_SIZE - len(tail)][::-1] + tail
            elif after is not None:
                items = self._select("id > ?", (after,), "ASC", PAGE_SIZE)
            elif before is not None:
                items = self._select("id < ?", (before,), "DESC", PAGE_SIZE)[::-1]
            else:
                items = self._select("1", (), "DESC", PAGE_SIZE)[::-1]

            return {
                "items": items,
                "has_older": bool(items) and self._exists("id < ?", (items[0]["id"],)),
            }

    def summary(self):
        with self._lock:
            latest_id = self._db.execute("SELECT COALESCE(MAX(id), 0) FROM logs").fetchone()[0]
            return {"latest_id": latest_id, "tag": self._meta("tag")}

    # ---- 阅读 Tag ----

    def set_tag(self, log_id):
        """阅读位置只前进，多个设备同时阅读时不会被较旧的位置覆盖；返回生效后的 Tag。
        log_id 取自页面已加载的日志，日志不会删除，所以不需要校验是否存在。"""
        with self._lock:
            tag = self._meta("tag")
            if tag and tag["log_id"] >= log_id:
                return tag
            tag = {"log_id": log_id, "updated_at": now_iso()}
            with self._db:
                self._set_meta("tag", tag)
            return tag

    # ---- 访问密码 ----

    def auth(self):
        with self._lock:
            return self._meta("auth")

    def set_auth(self, auth):
        with self._lock, self._db:
            self._set_meta("auth", auth)

    # ---- 规则 ----

    def rules(self):
        with self._lock:
            result = {kind: [] for kind in RULE_KINDS}
            for row in self._db.execute("SELECT * FROM rules ORDER BY id"):
                rule = dict(row)
                result[rule.pop("kind")].append(rule)
            return result

    def add_rules(self, kind, values, note):
        """返回新增条数；已存在的值会被跳过。"""
        now = now_iso()
        with self._lock, self._db:
            return self._db.executemany(
                "INSERT OR IGNORE INTO rules (kind, value, note, created_at) VALUES (?, ?, ?, ?)",
                [(kind, value, note, now) for value in values],
            ).rowcount

    def delete_rule(self, rule_id):
        with self._lock, self._db:
            self._db.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
