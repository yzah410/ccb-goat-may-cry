# -*- coding: utf-8 -*-
"""Bangumi 公开 API 的小客户端（只用标准库）。

用途：点击器在动手之前，先用和游戏**完全相同**的请求参数去问一遍 Bangumi，
预测「用哪个关键词、目标会排在第几项、要点几次『更多』」，从而挑出最省事的路径。
游戏页面里真正点击时仍然按 id 核验，这里的预测只是「计划」，算错了也只是多花点时间。
"""
from __future__ import annotations

import asyncio
import http.client
import json
import queue
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

UA = "ccb-goat-may-cry-clicker (+https://github.com/yzah410/ccb-goat-may-cry; local tool)"

# 角色图片 URL 里的 id：.../pic/crt/g/39/01/9169_crt_anidb.jpg
RE_CHAR_IMG_ID = re.compile(r"/crt/[a-z]/[0-9a-f]{2}/[0-9a-f]{2}/(\d+)_crt_", re.I)
# 作品封面 URL 里的 id：.../pic/cover/l/e5/69/265_Z5Uou.jpg
RE_SUBJECT_IMG_ID = re.compile(r"/cover/[a-z]/[0-9a-f]{2}/[0-9a-f]{2}/(\d+)_", re.I)

# 别名字段里常见的分隔符（例：「亚瑟王、骑士王、不列颠的红龙」）
_ALIAS_SPLIT = re.compile(r"[、，,/;；|｜]+")


def char_id_from_img(url: Optional[str]) -> Optional[int]:
    if not url:
        return None
    m = RE_CHAR_IMG_ID.search(url)
    return int(m.group(1)) if m else None


def subject_id_from_img(url: Optional[str]) -> Optional[int]:
    if not url:
        return None
    m = RE_SUBJECT_IMG_ID.search(url)
    return int(m.group(1)) if m else None


def infobox_value(detail: Optional[dict], key: str) -> Any:
    for it in (detail or {}).get("infobox") or []:
        if isinstance(it, dict) and it.get("key") == key:
            return it.get("value")
    return None


def cn_name_of(detail: Optional[dict]) -> Optional[str]:
    """和游戏同口径：infobox「简体中文名」。"""
    v = infobox_value(detail, "简体中文名")
    return v.strip() if isinstance(v, str) and v.strip() else None


def aliases_of(detail: Optional[dict]) -> List[str]:
    """infobox「别名」→ 拆成单个别名，去重保序。"""
    v = infobox_value(detail, "别名")
    raw: List[str] = []
    if isinstance(v, list):
        for x in v:
            if isinstance(x, dict) and isinstance(x.get("v"), str):
                raw.append(x["v"])
            elif isinstance(x, str):
                raw.append(x)
    elif isinstance(v, str):
        raw.append(v)
    out: List[str] = []
    for r in raw:
        for part in _ALIAS_SPLIT.split(r):
            part = part.strip()
            if part and part not in out:
                out.append(part)
    return out


class BgmError(RuntimeError):
    pass


class BgmClient:
    """标准库 http.client 长连接池 + asyncio.to_thread 包装；带重试、TTL 缓存、并发上限。

    为什么不用 urllib：urllib 每个请求都重新做一次 TLS 握手。网络环境不好（例如经过代理）时，握手偶尔会卡很久，可能到十几秒；
    长连接复用后单请求通常只要零点几秒、几乎不出现卡顿。
    """

    def __init__(self, base: str = "https://api.bgm.tv", timeout: float = 8.0,
                 retries: int = 3, ttl: float = 1800.0, max_concurrency: int = 4):
        self.base = base.rstrip("/")
        u = urlparse(self.base)
        self._https = u.scheme != "http"
        self._host = u.hostname or "api.bgm.tv"
        self._port = u.port
        self._prefix = (u.path or "").rstrip("/")
        self.timeout = timeout
        self.retries = max(1, int(retries))
        self.ttl = ttl
        self._cache: Dict[str, Tuple[float, Any]] = {}
        self._cache_lock = threading.Lock()
        # 池里存 (连接, 归还时刻)。服务端会关掉空闲几分钟的长连接（空闲几分钟后第一次请求可能
        # RemoteDisconnected；池里的几条全是死连接而重试只有 3 次 → 必失败），所以：
        # ① 取出时空闲超过 idle_max 秒的直接丢掉；② 复用的旧连接出连接类错误时清空整个池、立刻用新连接重试（不算重试次数）。
        self._pool: "queue.LifoQueue[Tuple[http.client.HTTPConnection, float]]" = queue.LifoQueue()
        self.idle_max = 20.0
        self._sem = threading.Semaphore(max_concurrency)
        self.calls = 0          # 实际发出的 HTTP 次数（调试/统计用）
        self.last_error: Optional[str] = None

    def _new_conn(self) -> http.client.HTTPConnection:
        cls = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
        return cls(self._host, self._port, timeout=self.timeout)

    def _get_conn(self) -> Tuple[http.client.HTTPConnection, bool]:
        """返回 (连接, 是否复用的旧连接)。"""
        now = time.time()
        while True:
            try:
                conn, t = self._pool.get_nowait()
            except queue.Empty:
                return self._new_conn(), False
            if now - t <= self.idle_max:
                return conn, True
            try:
                conn.close()
            except Exception:
                pass

    def _drain_pool(self) -> None:
        while True:
            try:
                conn, _ = self._pool.get_nowait()
            except queue.Empty:
                return
            try:
                conn.close()
            except Exception:
                pass

    # ---------------- 底层 ----------------
    def _request_sync(self, method: str, path: str, body: Optional[dict] = None,
                      cache: bool = True) -> Any:
        key = f"{method} {path} {json.dumps(body, ensure_ascii=False, sort_keys=True) if body else ''}"
        now = time.time()
        if cache:
            with self._cache_lock:
                hit = self._cache.get(key)
                if hit and now - hit[0] < self.ttl:
                    return hit[1]
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = {"User-Agent": UA, "Accept": "application/json", "Connection": "keep-alive"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        last_exc: Optional[BaseException] = None
        attempt = 0
        stale_retries = 0
        while attempt < self.retries:
            with self._sem:
                conn, reused = self._get_conn()
                try:
                    self.calls += 1
                    conn.request(method, self._prefix + path, body=data, headers=headers)
                    r = conn.getresponse()
                    raw = r.read()
                    status = r.status
                    self._pool.put((conn, time.time()))   # 读完响应体才能复用
                except Exception as e:           # 握手失败 / 连接被对端关掉 / 超时：丢弃这条连接，重试
                    try:
                        conn.close()
                    except Exception:
                        pass
                    last_exc = e
                    stale = isinstance(e, (http.client.RemoteDisconnected, http.client.BadStatusLine,
                                           ConnectionResetError, BrokenPipeError, ConnectionAbortedError))
                    if reused and stale and stale_retries < 2:
                        # 旧连接已被服务端关掉：清空整个池，马上用新连接重试，不算一次重试
                        stale_retries += 1
                        self._drain_pool()
                        continue
                    attempt += 1
                    time.sleep(0.3 * attempt)
                    continue
            if status == 404:
                if cache:
                    with self._cache_lock:
                        self._cache[key] = (time.time(), None)
                return None
            if status >= 400:
                last_exc = RuntimeError(f"HTTP {status}: {raw[:120]!r}")
                if status not in (408, 429, 500, 502, 503, 504):
                    break
                attempt += 1
                time.sleep(0.6 * attempt)
                continue
            val = json.loads(raw)
            if cache:
                with self._cache_lock:
                    self._cache[key] = (time.time(), val)
            self.last_error = None
            return val
        self.last_error = f"{type(last_exc).__name__}: {last_exc}"
        raise BgmError(f"Bangumi API 请求失败 {method} {path}：{self.last_error}")

    async def _req(self, method: str, path: str, body: Optional[dict] = None, cache: bool = True) -> Any:
        return await asyncio.to_thread(self._request_sync, method, path, body, cache)

    # ---------------- 角色 ----------------
    async def get_character(self, cid: int) -> Optional[dict]:
        return await self._req("GET", f"/v0/characters/{int(cid)}")

    async def character_subjects(self, cid: int) -> List[dict]:
        v = await self._req("GET", f"/v0/characters/{int(cid)}/subjects")
        return v if isinstance(v, list) else []

    async def search_characters(self, keyword: str, limit: int = 20, offset: int = 0) -> dict:
        """与游戏同一个接口：POST /v0/search/characters?limit=&offset=，body={keyword}。"""
        v = await self._req("POST", f"/v0/search/characters?limit={int(limit)}&offset={int(offset)}",
                            {"keyword": keyword.strip()})
        return v if isinstance(v, dict) else {"data": [], "total": 0}

    async def find_character_index(self, keyword: str, cid: int, max_index: int,
                                   concurrency: int = 4) -> Tuple[Optional[int], Optional[int]]:
        """按 20 条一页往后翻，找目标在「该关键词结果」里的 0 基位置。每批并发取 concurrency 页。

        返回 (index 或 None, total)。API 的 total 最多 1000、offset>=1000 返回空。
        """
        cap = min(int(max_index) + 1, 1000)
        total: Optional[int] = None
        off = 0
        while off < cap:
            batch = [o for o in range(off, min(off + 20 * concurrency, cap), 20)]
            if total is not None:
                batch = [o for o in batch if o < total]
                if not batch:
                    return None, total
            results = await asyncio.gather(*(self.search_characters(keyword, 20, o) for o in batch))
            for o, d in zip(batch, results):
                total = d.get("total") if d.get("total") is not None else total
                ids = [int(c.get("id")) for c in d.get("data") or [] if c.get("id") is not None]
                if int(cid) in ids:
                    return o + ids.index(int(cid)), total
                if len(ids) < 20:
                    return None, total
            off = batch[-1] + 20
        return None, total

    # ---------------- 作品 ----------------
    async def search_subjects(self, keyword: str, types: List[int]) -> List[dict]:
        """与游戏 searchSubjects() 完全一致：不带 limit 参数（API 默认 10 条），body 带 type 过滤。"""
        v = await self._req("POST", "/v0/search/subjects",
                            {"keyword": keyword.strip(), "filter": {"type": list(types)}})
        return list((v or {}).get("data") or []) if isinstance(v, dict) else []

    async def subject_characters(self, sid: int) -> List[dict]:
        """游戏 getCharactersBySubjectId()：只保留 relation 为 主角/配角 的，顺序不变。"""
        v = await self._req("GET", f"/v0/subjects/{int(sid)}/characters")
        if not isinstance(v, list):
            return []
        return [c for c in v if c.get("relation") in ("主角", "配角")]
