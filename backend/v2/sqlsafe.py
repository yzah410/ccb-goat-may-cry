# -*- coding: utf-8 -*-
"""只读 SQL 执行（「问数据」、工作台的 sql 条件、AI 问数据共用）。

四层防护：
1. 连接本身是只读的（file:...?mode=ro）；
2. 开头关键字白名单（SELECT / WITH / VALUES / EXPLAIN / 只读 PRAGMA；去注释时认得字符串）；
   另外原文里只要出现 VACUUM 就拒绝（VACUUM INTO 会写文件，权限回调管不到它本身）；
3. sqlite 权限回调（authorizer）：只放行读表、白名单里的函数、白名单里的只读 PRAGMA，其余（写、ATTACH、建表、事务……）一律拒绝；
4. PRAGMA query_only = 1。
另外：5 秒超时（progress handler 中止）、最多 2,000 行（sql 条件取 id 时另有上限）。
结果大小：返回的数据累计超过 MAX_RESULT_BYTES 就停（逐行累计，超了报「结果太大」）；
单个值超过 MAX_VALUE_BYTES 由 sqlite 自己拒绝（Python ≥ 3.11 用 setlimit(SQLITE_LIMIT_LENGTH)）。
Python 3.10 的 sqlite3 没有 setlimit，退而求其次：SQL 里出现 printf / format / replace 时，
给这几个函数包一层长度检查（见 _install_value_guards）；其余放大写法（递归 CTE 里的 || 拼接、
group_concat 等）3.10 下拦不住，只能靠超时和返回前的逐行累计。

清单以临时只读表的形式提供：user_list(id, name, kind)、user_list_item(list_id, item_id, name)。
"""
from __future__ import annotations

import re
import sqlite3
import time
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple  # noqa: F401

MAX_ROWS = 2000
TIMEOUT_S = 5.0
MAX_ID_ROWS = 2_000_000
MAX_SQL_CHARS = 20_000
MAX_RESULT_BYTES = 10 * 1024 * 1024     # 一次返回的数据累计上限（按返回的字节数算）
MAX_VALUE_BYTES = 64 * 1024 * 1024      # 单个值 / 单行的上限；正常数据里的单元格远小于它

# sqlite3 权限回调的动作码（Python 3.10 的 sqlite3 模块没导出全部常量，这里写数字）
A_PRAGMA = 19
A_READ = 20
A_SELECT = 21
A_FUNCTION = 31
A_RECURSIVE = 33
OK = 0
DENY = 1

ALLOWED_FUNCTIONS = {
    # 核心标量
    "abs", "char", "coalesce", "format", "glob", "hex", "ifnull", "iif", "instr", "length", "like", "likelihood",
    "likely", "lower", "ltrim", "max", "min", "nullif", "octet_length", "printf", "quote", "random", "replace",
    "round", "rtrim", "sign", "substr", "substring", "trim", "typeof", "unicode", "unlikely", "upper", "concat",
    "concat_ws", "unhex", "sqlite_version",
    # 聚合
    "avg", "count", "group_concat", "string_agg", "sum", "total",
    # 日期
    "date", "time", "datetime", "julianday", "strftime", "unixepoch", "timediff",
    # 窗口
    "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value",
    "last_value", "nth_value",
    # 数学
    "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "ceil", "ceiling", "cos", "cosh", "degrees", "exp",
    "floor", "ln", "log", "log10", "log2", "mod", "pi", "pow", "power", "radians", "sin", "sinh", "sqrt", "tan",
    "tanh", "trunc",
    # JSON
    "json", "json_array", "json_array_length", "json_extract", "json_insert", "json_object", "json_patch",
    "json_remove", "json_replace", "json_set", "json_type", "json_valid", "json_quote", "json_group_array",
    "json_group_object", "json_each", "json_tree",
}
READ_PRAGMAS = {"table_info", "table_xinfo", "index_list", "index_info", "index_xinfo", "foreign_key_list",
                "table_list", "database_list", "collation_list", "function_list"}
_LEAD_OK = {"select", "with", "values", "explain", "pragma"}


class SqlError(Exception):
    def __init__(self, message: str, detail: Optional[str] = None):
        self.message = message
        self.detail = detail
        super().__init__(message)


def _strip_comments(sql: str) -> str:
    """去掉注释（-- 到行尾、/* … */），但**认得字符串和带引号的名字**：
    '…'（'' 转义）、"…"、`…`、[…] 里面的 -- 和 /* 不算注释。
    （只用正则去注释会被「-- /*」换行「VACUUM … '…*/」这种写法骗过开头关键字检查，所以要认得字符串。）"""
    out = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if c == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j == -1 else j
            out.append(" ")
            continue
        if c == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j == -1 else j + 2
            out.append(" ")
            continue
        if c in "'\"`[":
            close = "]" if c == "[" else c
            j = i + 1
            while j < n:
                if sql[j] == close:
                    if close != "]" and j + 1 < n and sql[j + 1] == close:   # '' / "" 转义
                        j += 2
                        continue
                    break
                j += 1
            out.append(sql[i:j + 1])
            i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def clean_sql(sql: str) -> str:
    if not isinstance(sql, str) or not sql.strip():
        raise SqlError("SQL 是空的")
    if len(sql) > MAX_SQL_CHARS:
        raise SqlError(f"SQL 太长了（超过 {MAX_SQL_CHARS:,} 个字符）")
    s = sql.strip()
    while s.endswith(";"):
        s = s[:-1].rstrip()
    # VACUUM（包括 VACUUM INTO 写文件）权限回调管不到：原文里只要出现这个词就拒绝（宁可误伤）
    if re.search(r"\bvacuum\b", s, flags=re.I):
        raise SqlError("不允许 VACUUM", detail="SQL 里出现了 VACUUM")
    body = _strip_comments(s).strip()
    m = re.match(r"[A-Za-z]+", body)
    lead = (m.group(0) if m else "").lower()
    if lead not in _LEAD_OK:
        raise SqlError("只允许查询语句（SELECT / WITH …）", detail=f"开头是「{lead or body[:10]}」")
    return s


def _authorizer(action: int, arg1, arg2, dbname, source) -> int:
    if action in (A_SELECT, A_READ, A_RECURSIVE):
        return OK
    if action == A_FUNCTION:
        name = (arg2 or "").lower()
        return OK if name in ALLOWED_FUNCTIONS else DENY
    if action == A_PRAGMA:
        name = (arg1 or "").lower()
        return OK if name in READ_PRAGMAS else DENY
    return DENY


class _ValueTooBig(Exception):
    """Python 3.10 的函数包装发现要生成的值超过 MAX_VALUE_BYTES。"""


class _Guard:
    """prepare() 装上、查询结束后要收尾的东西（Python 3.10 的函数包装用一个辅助连接）。"""

    def __init__(self) -> None:
        self.aux: Optional[sqlite3.Connection] = None
        self.tripped = False        # 函数包装拦下过超大的值（sqlite 只会报「函数抛了异常」，要靠它认出原因）

    def close(self) -> None:
        if self.aux is not None:
            self.aux.close()
            self.aux = None


_AMPLIFIER_NAMES = re.compile(r"\b(printf|format|replace)\b", re.I)
# printf 的一个转换：%[标志][宽度或 *][.精度或 *][l / ll]转换字符；%% 不算转换
_PRINTF_SPEC = re.compile(r"%([-+ 0#!,]*)(\*|\d+)?(?:\.(\*|\d*))?l{0,2}([a-zA-Z%])")


def _count_arg(v: Any) -> int:
    """printf 里 `*` 取到的宽度 / 精度：和 sqlite 一样把文本、小数当整数用；转不了按 0。"""
    try:
        return abs(int(v))
    except OverflowError:
        return MAX_VALUE_BYTES + 1
    except (TypeError, ValueError):
        return 0


def _text_len(v: Any) -> int:
    if isinstance(v, (str, bytes)):
        return 2 * len(v) + 3        # %q / %Q / %w 会把引号翻倍
    return 24


def _printf_bound(fmt: str, args: Tuple[Any, ...]) -> int:
    """printf 输出长度的保守上界：格式里的字面字符 + 每个转换取「宽度、精度、参数文本长度、400」里最大的
    （400 够放下 %f 打印的最大浮点数）。例：`%.*c` 加一个很大的精度参数，就是把一个字符重复那么多次。"""
    total = len(fmt)
    it = iter(args)
    for m in _PRINTF_SPEC.finditer(fmt):
        if m.group(4) == "%":
            continue
        width, prec = m.group(2), m.group(3)
        w = _count_arg(next(it, None)) if width == "*" else int(width or 0)
        p = _count_arg(next(it, None)) if prec == "*" else int(prec or 0)
        total += max(w, p, 400, _text_len(next(it, None)))
    return total


def _as_text(v: Any) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode("utf-8", "replace")
    return str(v)


def _install_value_guards(conn: sqlite3.Connection, sql: Optional[str], guard: _Guard) -> None:
    """Python 3.10（没有 setlimit）：给会按参数放大输出的 printf / format / replace 包一层长度检查。
    检查通过后交给真正的 sqlite 函数算（辅助连接上没有被替换的同名函数），结果和不包装时一致。
    SQL 里没出现这几个名字就不装：函数名不能在运行时拼出来，没有名字就用不到，也不必付出包装的开销。"""
    if sql is not None and not _AMPLIFIER_NAMES.search(sql):
        return
    aux = guard.aux = sqlite3.connect(":memory:")

    def too_big() -> _ValueTooBig:
        guard.tripped = True
        return _ValueTooBig()

    def _printf(*args: Any) -> Any:
        if args and isinstance(args[0], str) and _printf_bound(args[0], args[1:]) > MAX_VALUE_BYTES:
            raise too_big()
        return aux.execute("SELECT printf(" + ",".join("?" * len(args)) + ")", args).fetchone()[0]

    def _replace(x: Any, y: Any, z: Any) -> Any:
        if x is None or y is None or z is None:
            return None
        tx, ty, tz = _as_text(x), _as_text(y), _as_text(z)
        if ty and len(tz) > len(ty) and len(tx) + tx.count(ty) * (len(tz) - len(ty)) > MAX_VALUE_BYTES:
            raise too_big()
        if isinstance(x, str) and isinstance(y, str) and isinstance(z, str):
            return x.replace(y, z) if y else x
        return aux.execute("SELECT replace(?,?,?)", (x, y, z)).fetchone()[0]

    conn.create_function("printf", -1, _printf, deterministic=True)
    conn.create_function("format", -1, _printf, deterministic=True)
    conn.create_function("replace", 3, _replace, deterministic=True)


def _install_lists(conn: sqlite3.Connection, lists: Iterable[Dict[str, Any]]) -> None:
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("CREATE TEMP TABLE user_list(id TEXT PRIMARY KEY, name TEXT, kind TEXT)")
    conn.execute("CREATE TEMP TABLE user_list_item(list_id TEXT, item_id INTEGER, name TEXT)")
    rows, items = [], []
    for d in lists or ():
        lid = d.get("id")
        rows.append((lid, d.get("name"), d.get("kind")))
        for it in d.get("items") or ():
            items.append((lid, it.get("id"), it.get("name")))
    conn.executemany("INSERT INTO temp.user_list VALUES(?,?,?)", rows)
    conn.executemany("INSERT INTO temp.user_list_item VALUES(?,?,?)", items)


def prepare(conn: sqlite3.Connection, lists: Iterable[Dict[str, Any]] = (), timeout_s: float = TIMEOUT_S,
            sql: Optional[str] = None) -> _Guard:
    """在已打开的只读连接上装好清单表、query_only、权限回调、超时和单个值的大小上限。之后这个连接只能读。
    返回的 _Guard 要在查询结束后 close()。sql 是要执行的语句：Python 3.10 下只有语句里用到 printf / format / replace
    才装函数包装；不传就一律装。"""
    _install_lists(conn, lists)
    conn.execute("PRAGMA query_only = 1")
    guard = _Guard()
    if hasattr(conn, "setlimit"):       # Python ≥ 3.11：让 sqlite 自己拒绝超大的值（任何函数、拼接都管得到）
        conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_VALUE_BYTES)
    else:
        _install_value_guards(conn, sql, guard)
    conn.set_authorizer(_authorizer)
    deadline = time.perf_counter() + timeout_s

    def _progress():
        return 1 if time.perf_counter() > deadline else 0

    conn.set_progress_handler(_progress, 2000)
    return guard


def _zh_error(e: Exception, timeout_s: float, guard: Optional[_Guard] = None) -> SqlError:
    msg = str(e)
    low = msg.lower()
    if "string or blob too big" in low or (guard is not None and guard.tripped):
        return SqlError(f"SQL 生成了超过 {MAX_VALUE_BYTES // 2**20} MB 的单个值，已中止"
                        "（检查 printf、replace、|| 拼接的用法）", detail=msg)
    if "interrupted" in low:
        return SqlError(f"查询超过 {timeout_s:g} 秒，已中止（可以加 LIMIT 或缩小范围）", detail=msg)
    if "not authorized" in low or "prohibited" in low:
        return SqlError("这条 SQL 想做只读以外的事（写入、ATTACH、PRAGMA 写、不允许的函数……），已拒绝", detail=msg)
    if "one statement at a time" in low:
        return SqlError("一次只能执行一条查询", detail=msg)
    if "readonly" in low or "read-only" in low:
        return SqlError("数据库是只读的，不能写入", detail=msg)
    if "no such table" in low:
        return SqlError("表不存在：" + msg.split(":", 1)[-1].strip(), detail=msg)
    if "no such column" in low:
        return SqlError("列不存在：" + msg.split(":", 1)[-1].strip(), detail=msg)
    if "no such function" in low:
        return SqlError("函数不存在：" + msg.split(":", 1)[-1].strip(), detail=msg)
    if "syntax error" in low:
        return SqlError("SQL 语法错误：" + msg, detail=msg)
    return SqlError("SQL 执行出错：" + msg, detail=msg)


def _cell(v: Any) -> Any:
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"<二进制 {len(bytes(v))} 字节>"
    return v


def _cell_bytes(v: Any) -> int:
    """一个（已经过 _cell 的）返回值占多少字节：文字按 UTF-8，数字按 8，空值 0。"""
    if isinstance(v, str):
        return len(v) if v.isascii() else len(v.encode("utf-8", "replace"))
    return 0 if v is None else 8


def run_query(conn: sqlite3.Connection, sql: str, limit: int = MAX_ROWS, lists: Iterable[Dict[str, Any]] = (),
              timeout_s: float = TIMEOUT_S) -> Dict[str, Any]:
    """在一个**新开的**只读连接上执行（调用方负责打开和关闭）。"""
    limit = max(1, min(int(limit or MAX_ROWS), MAX_ROWS))
    s = clean_sql(sql)
    t0 = time.perf_counter()
    guard: Optional[_Guard] = None
    rows: List[List[Any]] = []
    try:
        guard = prepare(conn, lists, timeout_s, s)
        cur = conn.execute(s)
        cols = [d[0] for d in (cur.description or [])]
        used = 0
        for r in cur:                          # 逐行取、逐行累计字节：不会一次把一大批超大的行读进内存
            row = [_cell(v) for v in r]
            used += sum(_cell_bytes(v) for v in row)
            if used > MAX_RESULT_BYTES:
                raise SqlError(f"结果太大（超过 {MAX_RESULT_BYTES // 2**20} MB），已中止"
                               "（可以少选几列、加 LIMIT，或用 substr() 截短长文本）")
            rows.append(row)
            if len(rows) > limit:              # 多取一行，只为知道有没有被截断
                break
    except (sqlite3.Error, sqlite3.Warning) as e:
        raise _zh_error(e, timeout_s, guard) from None
    finally:
        if guard is not None:
            guard.close()
    truncated = len(rows) > limit
    rows = rows[:limit]
    return {"columns": cols, "rows": rows, "truncated": truncated,
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1)}


def run_ids_checked(conn: sqlite3.Connection, sql: str, lists: Iterable[Dict[str, Any]] = (),
                    timeout_s: float = TIMEOUT_S) -> Tuple[Set[int], int, int]:
    """sql 条件：取第一列当 character_id。返回 (id 集合, 总行数, 第一列不是整数的行数)。
    只认整数（和整数值的小数）；文字一律不认——名字恰好是纯数字的角色不会被当成 id。"""
    s = clean_sql(sql)
    out: Set[int] = set()
    n = bad = 0
    guard: Optional[_Guard] = None
    try:
        guard = prepare(conn, lists, timeout_s, s)
        cur = conn.execute(s)
        for r in cur:                          # 逐行取：只留第一列，其余列（可能很大）读完就丢
            n += 1
            v = r[0] if r else None
            if isinstance(v, bool):
                bad += 1
            elif isinstance(v, int):
                out.add(v)
            elif isinstance(v, float) and v.is_integer():
                out.add(int(v))
            else:
                bad += 1
            if n > MAX_ID_ROWS:
                raise SqlError(f"自定义查询返回超过 {MAX_ID_ROWS:,} 行，太多了")
    except (sqlite3.Error, sqlite3.Warning) as e:
        raise _zh_error(e, timeout_s, guard) from None
    finally:
        if guard is not None:
            guard.close()
    return out, n, bad


# 测试用：运行时只用 run_ids_checked
def run_ids(conn: sqlite3.Connection, sql: str, lists: Iterable[Dict[str, Any]] = (),
            timeout_s: float = TIMEOUT_S) -> Set[int]:
    return run_ids_checked(conn, sql, lists, timeout_s)[0]
