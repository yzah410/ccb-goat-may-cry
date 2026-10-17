# -*- coding: utf-8 -*-
"""只读 SQL：拦截写操作（INSERT/UPDATE/DELETE/ATTACH/PRAGMA 写/不允许的函数）、超时、行数上限、清单临时表。"""
from __future__ import annotations

import os
import sqlite3
import unittest
from unittest import mock

from . import base
from backend.v2 import sqlsafe
from backend.v2.storage import LISTS
from backend.v2.store import open_ro


def q(sql, **kw):
    conn = open_ro(base.DB)
    try:
        return sqlsafe.run_query(conn, sql, lists=LISTS.all(), **kw)
    finally:
        conn.close()


def blocked(test: unittest.TestCase, sql: str, needle: str = "") -> str:
    with test.assertRaises(sqlsafe.SqlError) as cm:
        q(sql)
    if needle:
        test.assertIn(needle, cm.exception.message)
    return cm.exception.message


class TestReadOnlySql(unittest.TestCase):
    def test_select_ok(self):
        r = q("SELECT COUNT(*) AS n FROM character")
        self.assertEqual(r["columns"], ["n"])
        self.assertEqual(r["rows"], [[17]])
        self.assertFalse(r["truncated"])

    def test_views_and_functions(self):
        r = q("SELECT character_id, group_concat(tag, '、') FROM game_tag_n4 WHERE character_id = 1 GROUP BY character_id")
        self.assertEqual(r["rows"][0][0], 1)
        r = q("WITH t AS (SELECT heat FROM character) SELECT max(heat), abs(-1), round(1.26, 1), strftime('%Y', '2024-01-02') FROM t")
        self.assertEqual(r["rows"][0], [900, 1, 1.3, "2024"])

    def test_write_statements_blocked(self):
        blocked(self, "INSERT INTO character(id, heat) VALUES (999, 1)", "只允许查询")
        blocked(self, "UPDATE character SET heat = 0", "只允许查询")
        blocked(self, "DELETE FROM character", "只允许查询")
        blocked(self, "DROP TABLE character", "只允许查询")
        blocked(self, "CREATE TABLE x(a)", "只允许查询")
        blocked(self, "  /* 注释 */ -- x\n DELETE FROM character", "只允许查询")
        # WITH 开头骗过关键字白名单 → 权限回调拦下
        blocked(self, "WITH x AS (SELECT 1) DELETE FROM character", "只读以外")
        blocked(self, "WITH x AS (SELECT 1) INSERT INTO character(id, heat) SELECT 999, 1", "只读以外")
        self.assertEqual(q("SELECT COUNT(*) FROM character")["rows"], [[17]])     # 真的没写进去

    def test_attach_vacuum_blocked(self):
        blocked(self, f"ATTACH DATABASE '{base.DB}' AS x", "只允许查询")
        out = os.path.join(base.TMP, "stolen.sqlite")
        blocked(self, f"VACUUM INTO '{out}'", "VACUUM")
        self.assertFalse(os.path.exists(out))

    def test_pragma(self):
        self.assertTrue(q("PRAGMA table_info(character)")["rows"])            # 只读 PRAGMA 可以
        blocked(self, "PRAGMA query_only = 0", "只读以外")
        blocked(self, "PRAGMA user_version = 5", "只读以外")
        blocked(self, "PRAGMA writable_schema = 1", "只读以外")
        blocked(self, "PRAGMA journal_mode = DELETE", "只读以外")

    def test_functions_blocked(self):
        blocked(self, "SELECT load_extension('evil')", "只读以外")
        blocked(self, "SELECT randomblob(100000000)", "只读以外")
        blocked(self, "SELECT zeroblob(100000000)", "只读以外")
        blocked(self, "SELECT fts3_tokenizer('x')")

    def test_multiple_statements(self):
        blocked(self, "SELECT 1; SELECT 2", "一条")
        self.assertEqual(q("SELECT 1;")["rows"], [[1]])                          # 末尾分号可以

    def test_timeout(self):
        with self.assertRaises(sqlsafe.SqlError) as cm:
            q("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c", timeout_s=0.3)
        self.assertIn("超过", cm.exception.message)

    def test_row_limit(self):
        sql = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) SELECT x FROM c"
        r = q(sql)
        self.assertEqual(len(r["rows"]), 2000)
        self.assertTrue(r["truncated"])
        r = q(sql, limit=10)
        self.assertEqual(len(r["rows"]), 10)
        r = q(sql, limit=999999)                                                   # 上限还是 2000
        self.assertEqual(len(r["rows"]), 2000)

    def test_user_list_tables(self):
        r = q("SELECT name FROM user_list_item WHERE list_id = 'l_t' ORDER BY name")
        self.assertEqual(sorted(x[0] for x in r["rows"]), sorted(["百合", "日常", "战斗"]))
        r = q("SELECT kind FROM user_list WHERE id = 'l_c'")
        self.assertEqual(r["rows"], [["character"]])
        blocked(self, "INSERT INTO user_list VALUES ('x', 'x', 'tag')", "只允许查询")
        blocked(self, "WITH a AS (SELECT 1) DELETE FROM user_list", "只读以外")

    def test_run_ids(self):
        conn = open_ro(base.DB)
        try:
            ids = sqlsafe.run_ids(conn, "SELECT id, heat FROM character WHERE heat >= 400")
        finally:
            conn.close()
        self.assertEqual(ids, {1, 5, 9, 10})

    def test_connection_really_readonly(self):
        conn = open_ro(base.DB)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("CREATE TABLE zz(a)")
        finally:
            conn.close()

    def test_empty_and_long(self):
        blocked(self, "   ", "空")
        blocked(self, "SELECT 1 " + " " * sqlsafe.MAX_SQL_CHARS, "太长")


HAS_SETLIMIT = hasattr(sqlite3.Connection, "setlimit")       # Python ≥ 3.11


class _LimitRecordingConn(sqlite3.Connection):
    """假装有 setlimit 的连接：记下 prepare() 设了什么上限（Python 3.10 没有这个 API，3.11+ 的真实现被它盖住）。"""

    def setlimit(self, category, limit):
        self.limit_calls = getattr(self, "limit_calls", []) + [(category, limit)]
        return 0


class TestResultSize(unittest.TestCase):
    """单元格 / 结果大小：逐行累计字节；Python ≥ 3.11 用 setlimit，3.10 给 printf / format / replace 包长度检查。"""

    def test_big_printf_result_rejected(self):
        """一个 printf 就能很快造出 20MB 的单元格；超过 MAX_RESULT_BYTES 时要报「结果太大」。"""
        msg = blocked(self, "SELECT printf('%.*c', 20000000, 'x')", "结果太大")
        self.assertIn("10 MB", msg)

    def test_rows_add_up(self):
        sql = ("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) "
               "SELECT printf('%.*c', 600, 'x') FROM c")
        with mock.patch.object(sqlsafe, "MAX_RESULT_BYTES", 1000):
            blocked(self, sql, "结果太大")                                  # 5 行 × 600 字节 > 1000
        with mock.patch.object(sqlsafe, "MAX_RESULT_BYTES", 3000):
            r = q(sql)
            self.assertEqual(len(r["rows"]), 5)
            self.assertFalse(r["truncated"])

    def test_size_counted_in_utf8_bytes(self):
        sql = "SELECT printf('%.*c', 40, '汉')"                             # 40 个汉字 = 120 字节
        with mock.patch.object(sqlsafe, "MAX_RESULT_BYTES", 100):
            blocked(self, sql, "结果太大")
        with mock.patch.object(sqlsafe, "MAX_RESULT_BYTES", 130):
            self.assertEqual(len(q(sql)["rows"][0][0]), 40)

    def test_normal_results_unaffected(self):
        r = q("SELECT name, name_cn FROM character ORDER BY id")
        self.assertEqual(len(r["rows"]), 17)
        self.assertFalse(r["truncated"])

    def test_huge_printf_never_returns_the_value(self):
        """3.10：函数包装直接报错；3.11+：sqlite 自己拒绝，printf 给 NULL。两种都不会真的造出 2 亿字符。"""
        for sql in ("SELECT printf('%.*c', 200000000, 'x')", "SELECT format('%.*c', 900000000, 'x')",
                    "SELECT PRINTF('%*d', 900000000, 1)", "SELECT printf('%-*s|', 900000000, 'a')",
                    "SELECT printf('%.999999999f', 1.5)"):
            with self.subTest(sql=sql):
                try:
                    r = q(sql)
                except sqlsafe.SqlError as e:
                    self.assertIn("64 MB", e.message)
                else:
                    self.assertEqual(r["rows"], [[None]])

    def test_replace_amplification_rejected(self):
        a = "'" + "a" * 20 + "'"
        sql = "SELECT length(" + "replace(" * 8 + a + (", 'a', " + a + ")") * 8 + ")"      # 20 的 9 次方
        blocked(self, sql, "64 MB")

    def test_ids_path_also_limited(self):
        conn = open_ro(base.DB)
        try:
            with self.assertRaises(sqlsafe.SqlError) as cm:
                sqlsafe.run_ids(conn, "SELECT id, replace(replace(replace(replace(replace(replace(replace(replace("
                                      "'aaaaaaaaaaaaaaaaaaaa', 'a', 'aaaaaaaaaaaaaaaaaaaa'), 'a', 'aaaaaaaaaaaaaaaaaaaa'), "
                                      "'a', 'aaaaaaaaaaaaaaaaaaaa'), 'a', 'aaaaaaaaaaaaaaaaaaaa'), 'a', 'aaaaaaaaaaaaaaaaaaaa'), "
                                      "'a', 'aaaaaaaaaaaaaaaaaaaa'), 'a', 'aaaaaaaaaaaaaaaaaaaa'), 'a', 'aaaaaaaaaaaaaaaaaaaa') "
                                      "FROM character")
        finally:
            conn.close()
        self.assertIn("64 MB", cm.exception.message)

    def test_too_big_error_text(self):
        e = sqlsafe._zh_error(sqlite3.DataError("string or blob too big"), 5.0)
        self.assertIn("64 MB", e.message)
        self.assertEqual(e.detail, "string or blob too big")

    def test_setlimit_used_when_available(self):
        conn = sqlite3.connect(":memory:", factory=_LimitRecordingConn)
        try:
            with mock.patch.object(sqlite3, "SQLITE_LIMIT_LENGTH", 0, create=True):
                g = sqlsafe.prepare(conn, (), 5.0, "SELECT printf('%d', 1)")
            g.close()
            self.assertEqual(conn.limit_calls, [(0, sqlsafe.MAX_VALUE_BYTES)])
            self.assertIsNone(g.aux)                                      # 有 setlimit 就不装函数包装
        finally:
            conn.close()

    @unittest.skipIf(HAS_SETLIMIT, "只有 Python 3.10 才装函数包装")
    def test_wrappers_only_when_sql_uses_the_functions(self):
        for sql, wrapped in (("SELECT 1", False), ("SELECT abs(-1), json_replace('{}', '$.a', 1)", False),
                             ("SELECT printf('%d', 1)", True), ("select REPLACE(name, 'a', 'b') from character", True),
                             ("SELECT format('%s', 1)", True)):
            with self.subTest(sql=sql):
                conn = sqlite3.connect(":memory:")
                try:
                    g = sqlsafe.prepare(conn, (), 5.0, sql)
                    self.assertEqual(g.aux is not None, wrapped)
                    g.close()
                finally:
                    conn.close()

    def test_wrapped_functions_give_native_results(self):
        """包装不能改变正常用法的结果：和不带包装的 sqlite 逐条对照。"""
        sqls = [
            "SELECT printf('%05d|%s|%.2f|%5.1f%%', 42, 'ab', 3.14159, 99.5)",
            "SELECT printf('%d %i %u %x %X %o %c', 255, 255, 255, 255, 255, 255, 'z')",
            "SELECT printf('%e|%E|%g|%G|%10.3f|%-10.3f|%+d', 12345.678, 12345.678, 0.00001234, 1e20, 3.14159, 3.14159, 5)",
            "SELECT printf('%s|%q|%Q|%w', 'it''s', 'it''s', 'it''s', 'a\"b')",
            "SELECT printf('%*d|%-*d|%.*f', 6, 42, 6, 42, 2, 3.14159)",
            "SELECT printf('%d', NULL), printf('%s', NULL), printf(NULL), printf('abc'), printf('%d%%', 50), printf()",
            "SELECT printf('%d', '12abc'), printf('%s', 12.5), printf('%s', x'41'), printf('%5s|%-5s|', 'ab', 'cd')",
            "SELECT format('%.1f', 2.25), format('%3d', 7)",
            "SELECT replace('hello world', 'o', '0'), replace('aaa', 'aa', 'b'), replace('abc', '', 'z'), replace('abc', 'x', 'y')",
            "SELECT replace(NULL, 'a', 'b'), replace('a', NULL, 'b'), replace('a', 'a', NULL), replace('', 'a', 'b')",
            "SELECT replace(12345, '3', 'x'), replace('a1b', 1, 2), replace(1.5, '.', ','), replace(x'414243', 'B', 'x')",
            "SELECT replace('汉字汉', '汉', 'Han'), upper(replace('a-b', '-', '_'))",
        ]
        native = sqlite3.connect(":memory:")
        try:
            for sql in sqls:
                with self.subTest(sql=sql):
                    want = [[sqlsafe._cell(v) for v in row] for row in native.execute(sql).fetchall()]
                    conn = sqlite3.connect(":memory:")
                    try:
                        got = sqlsafe.run_query(conn, sql)["rows"]
                    finally:
                        conn.close()
                    self.assertEqual(got, want)
        finally:
            native.close()

    def test_wrapped_functions_on_table_data(self):
        r = q("SELECT printf('%03d:%s', id, replace(name, 'e', 'E')) FROM character ORDER BY id LIMIT 3")
        conn = open_ro(base.DB)
        try:
            want = conn.execute("SELECT printf('%03d:%s', id, replace(name, 'e', 'E')) FROM character ORDER BY id LIMIT 3").fetchall()
        finally:
            conn.close()
        self.assertEqual(r["rows"], [list(x) for x in want])


class TestPrintfBound(unittest.TestCase):
    def test_bound(self):
        b = sqlsafe._printf_bound
        self.assertGreaterEqual(b("%.*c", (20_000_000, "x")), 20_000_000)
        self.assertGreaterEqual(b("%*d", (5_000_000, 1)), 5_000_000)
        self.assertGreaterEqual(b("%-30000000s", ("a",)), 30_000_000)
        self.assertGreaterEqual(b("%s", ("y" * 1000,)), 1000)
        self.assertGreater(b("%q", ("'" * 1000,)), 2000)                   # 引号会翻倍
        self.assertGreater(b("%.99999999999999999999c", ("x",)), sqlsafe.MAX_VALUE_BYTES)
        self.assertGreater(b("%.*c", (1e300, "x")), sqlsafe.MAX_VALUE_BYTES)
        self.assertGreater(b("%.*c", (float("inf"), "x")), sqlsafe.MAX_VALUE_BYTES)

    def test_big_numbers_that_are_not_widths_are_fine(self):
        b = sqlsafe._printf_bound
        self.assertLess(b("%d rows, %d bytes", (30_000_000, 10**12)), 1000)
        self.assertLess(b("%d%% of %s", (50, "total")), 1000)               # %% 不吃参数
        self.assertLess(b("%.2f", (1e300,)), 1000)

    def test_star_args_consumed_in_order(self):
        b = sqlsafe._printf_bound
        self.assertLess(b("%*d %d", (5, 30_000_000, 30_000_000)), 1000)     # 宽度 5，值 30000000，再一个值
        self.assertGreater(b("%*d", (30_000_000, 1)), 30_000_000 - 1)


if __name__ == "__main__":
    unittest.main()
