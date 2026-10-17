# -*- coding: utf-8 -*-
"""导图 × 单人猜猜呗联动的后端：导图反向索引、edited_at、预选（贪心）、图组存储、/v2/maplink 接口。

导图一律写进临时目录（patch MapStore.dir / SetStore.dir / PlanStore.dir），不碰真实数据。
合成库见 synth.py（all_with() = 17 人 c1..c17；每人的作品见各用例注释）。
"""
from __future__ import annotations

import itertools
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock
from urllib.parse import quote

from fastapi import FastAPI
from fastapi.testclient import TestClient

from . import base
from backend.v2 import maplink, maplink_router, maps, tagnote
from backend.v2.maps import MapIndex
from backend.v2.storage import PLANS, PlanStore, StorageError
from backend.v2.store import C_HEAT, with_snapshot

app = FastAPI()
app.include_router(maplink_router.router)
client = TestClient(app)

SPEC_ALL = base.all_with()          # 题库 17 人


def card(wid, subject_id=None, char_id=None, title=None):
    w = {"id": str(wid), "title": title or f"作品{wid}", "tags": ["TV"], "years": "2024", "score": None}
    if subject_id is not None:
        w["subject_id"] = subject_id
    if char_id is not None:
        w["char_id"] = char_id
    return w


def collection(title, cards, generated_at="2026-01-01", **extra):
    data = tagnote.make_collection(cards, title, "manual", group=extra.pop("group", None), **extra)
    data["collection"]["generated_at"] = generated_at
    return data


def clock(day0=1):
    """一个「每次调用走一天」的 now_iso，用来控制 edited_at 的先后。"""
    n = itertools.count(day0)
    return lambda: f"2026-10-{next(n):02d}T12:00:00Z"


class TempData(unittest.TestCase):
    """MapStore / PlanStore / SetStore 都指到临时目录；导图索引缓存每个用例前后清空。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maplink_")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for target, attr, sub in ((maps.MapStore, "dir", "maps_v2"), (maplink.SetStore, "dir", "maplink_v2")):
            p = mock.patch.object(target, attr, return_value=root / sub)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(PlanStore, "dir", return_value=str(root / "plans_v2"))
        p.start()
        self.addCleanup(p.stop)
        os.makedirs(root / "plans_v2", exist_ok=True)
        self._reset_cache()
        self.addCleanup(self._reset_cache)
        self.store = maps.MAPS

    @staticmethod
    def _reset_cache():
        maps.MAPS._summaries.clear()
        maps.MAPS._bad.clear()
        maps.MAPS._index = None

    def add(self, title, cards, generated_at="2026-01-01", **extra):
        return self.store.create(collection(title, cards, generated_at, **extra))["id"]

    def post(self, **body):
        return client.post("/v2/maplink/preselect", json=body)

    def pre(self, **body):
        body.setdefault("spec", SPEC_ALL)
        r = self.post(**body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


# ---------------------------------------------------------------- 反向索引
class TestIndex(TempData):
    def test_reverse_lookup_by_subject_and_char(self):
        a = self.add("甲", [card(1, 101, 1), card(2, 102, 4)])
        b = self.add("乙", [card(1, 101, 2), card(3, 103, None)])
        idx = self.store.index()
        self.assertEqual(set(idx.summaries), {a, b})
        self.assertEqual(idx.maps_for_subject(101), tuple(sorted((a, b))))
        self.assertEqual(idx.maps_for_subject(102), (a,))
        self.assertEqual(idx.maps_for_subject(103), (b,))
        self.assertEqual(idx.maps_for_char(1), (a,))
        self.assertEqual(idx.maps_for_char(2), (b,))
        self.assertEqual(idx.maps_for_char(4), (a,))
        self.assertEqual(idx.maps_for_subject(999), ())
        self.assertEqual(idx.maps_for_char(999), ())
        self.assertEqual(idx.subjects[a], frozenset({101, 102}))
        self.assertEqual(idx.chars[b], frozenset({2}))

    def test_hand_written_and_malformed_ids_are_ignored(self):
        def odd(wid, subject_id, char_id):
            w = card(wid, None, None)
            w.update({"subject_id": subject_id, "char_id": char_id})
            return w
        cards = [card(1), odd(2, True, False), odd(3, 101.5, None), odd(4, "abc", "x1"), odd(5, 101.0, 7.0),
                 odd(6, "1e3", " 7"), odd(7, "１０１", "７"), odd(8, "", "7\n"), odd(9, "-1", "+7"), odd(10, [101], {"a": 1})]
        mid = self.add("手写", cards)
        idx = self.store.index()
        self.assertIn(mid, idx.summaries)
        self.assertEqual((idx.subjects[mid], idx.chars[mid]), (frozenset(), frozenset()))
        self.assertEqual(idx.by_subject, {})
        self.assertEqual(idx.by_char, {})

    def test_int_or_none_table(self):
        good = {101: 101, "101": 101, "0": 0, "007": 7, 0: 0, "9" * 15: 10 ** 15 - 1}
        for raw, want in good.items():
            with self.subTest(raw=raw):
                self.assertEqual(maps._int_or_none(raw), want)
        for raw in (True, False, 101.0, 101.5, float("nan"), "abc", "1e3", "101.0", " 101", "101 ", "101\n", "-1", "+1",
                    "１０１", "", None, [101], {}, "9" * 16):
            with self.subTest(raw=raw):
                self.assertIsNone(maps._int_or_none(raw))

    def test_string_and_int_ids_are_the_same_id(self):
        # 导入的图里 subject_id / char_id 有的是字符串有的是整数；题库里都是整数。
        def odd(wid, subject_id, char_id):
            w = card(wid, None, None)
            w.update({"subject_id": subject_id, "char_id": char_id})
            return w
        a = self.add("字符串", [odd(1, "101", "1"), odd(2, "102", None)])
        b = self.add("整数", [card(1, 101, 1), card(2, 102, None)])
        c = self.add("混合", [odd(1, "101", 4), odd(2, 103, "5"), odd(3, True, "x")])
        idx = self.store.index()
        self.assertEqual((idx.subjects[a], idx.chars[a]), (frozenset({101, 102}), frozenset({1})))
        self.assertEqual((idx.subjects[c], idx.chars[c]), (frozenset({101, 103}), frozenset({4, 5})))
        self.assertEqual(idx.maps_for_subject(101), tuple(sorted((a, b, c))))
        self.assertEqual(idx.maps_for_char(1), tuple(sorted((a, b))))
        self.assertEqual(idx.maps_for_char(5), (c,))
        self.assertEqual(idx.by_subject.keys(), {101, 102, 103})
        self.assertTrue(all(isinstance(k, int) for k in list(idx.by_subject) + list(idx.by_char)))

    def test_many_maps_for_one_subject_sorted_by_map_id(self):
        ids = [self.add(f"图{i}", [card(1, 101, None)]) for i in range(5)]
        self.assertEqual(self.store.index().maps_for_subject(101), tuple(sorted(ids)))

    def test_index_is_reused_until_a_file_changes(self):
        mid = self.add("甲", [card(1, 101, 1)])
        first = self.store.index()
        with mock.patch.object(maps.MapStore, "_get", side_effect=AssertionError("不该再读文件")):
            self.assertIs(self.store.index(), first)
            self.store.all()                                  # 列表接口也走同一份缓存
        # 改名 -> 文件变了 -> 新索引
        self.store.patch(mid, {"title": "甲改"})
        second = self.store.index()
        self.assertIsNot(second, first)
        self.assertEqual(second.summaries[mid]["title"], "甲改")
        self.assertIs(self.store.index(), second)
        # 新增、删除也会更新
        other = self.add("乙", [card(1, 102, None)])
        self.assertEqual(self.store.index().maps_for_subject(102), (other,))
        self.assertTrue(self.store.delete(other))
        self.assertEqual(self.store.index().maps_for_subject(102), ())

    def test_file_rewritten_outside_the_service_is_picked_up(self):
        mid = self.add("甲", [card(1, 101, 1)])
        self.assertEqual(self.store.index().maps_for_subject(101), (mid,))
        path = self.store.dir() / f"{mid}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["works"].append(card(2, 555, 7))                 # 大小变了
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        idx = self.store.index()
        self.assertEqual(idx.maps_for_subject(555), (mid,))
        self.assertEqual(idx.maps_for_char(7), (mid,))

    def test_empty_library(self):
        idx = self.store.index()
        self.assertEqual((idx.summaries, idx.by_subject, idx.by_char), ({}, {}, {}))


# ---------------------------------------------------------------- 坏图不拖垮索引
class TestBadMaps(TempData):
    def write_raw(self, name, text):
        d = self.store.dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(text, encoding="utf-8")

    def break_map(self, mid, how):
        path = self.store.dir() / f"{mid}.json"
        if how == "json":
            path.write_text("{坏了", encoding="utf-8")
        elif how == "too_many_works":
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw["works"] = [card(i, 100 + i, None) for i in range(201)]
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        elif how == "deep":
            path.write_text("[" * 100000, encoding="utf-8")
        elif how == "schema":
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw["schema"] = "other/9"
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        elif how == "no_updated_at":
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw.pop("updated_at")
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        else:
            raise AssertionError(how)

    def test_one_bad_map_does_not_break_the_index(self):
        good = self.add("好", [card(1, 101, 1)])
        for how in ("json", "too_many_works", "deep", "schema", "no_updated_at"):
            with self.subTest(how=how):
                self._reset_cache()
                bad = self.add(f"坏-{how}", [card(1, 102, 2)])
                self.break_map(bad, how)
                idx = self.store.index()
                self.assertEqual(set(idx.summaries), {good})
                self.assertEqual(idx.maps_for_subject(101), (good,))
                self.assertEqual(idx.maps_for_subject(102), ())
                self.assertEqual([s["id"] for s in idx.skipped], [bad])
                self.assertTrue(idx.skipped[0]["reason"])
                self.assertIsInstance(idx.skipped[0]["reason"], str)
                self.store.delete(bad)

    def test_reasons_say_what_is_wrong(self):
        a = self.add("甲", [card(1, 101, 1)])
        b = self.add("乙", [card(1, 102, 1)])
        self.break_map(a, "json")
        self.break_map(b, "too_many_works")
        self.write_raw("notes.json", "{}")                       # 文件名不是 m_ 加 12 位十六进制
        by = {s["id"]: s["reason"] for s in self.store.index().skipped}
        self.assertEqual(set(by), {a, b, "notes"})
        self.assertIn("读取导图失败", by[a])
        self.assertIn("works", by[b])
        self.assertIn("导图 id", by["notes"])
        self.assertEqual([s["id"] for s in self.store.index().skipped], sorted(by))   # 按图 id 排序

    def test_skipped_is_reported_on_cache_hits_without_rereading_bad_files(self):
        good = self.add("好", [card(1, 101, 1)])
        bad = self.add("坏", [card(1, 102, 2)])
        self.break_map(bad, "json")
        first = self.store.index()
        with mock.patch.object(maps.MapStore, "_get", side_effect=AssertionError("不该再读文件")):
            second = self.store.index()
        self.assertIs(second, first)
        self.assertEqual([s["id"] for s in second.skipped], [bad])
        self.assertEqual(list(second.summaries), [good])

    def test_a_repaired_map_comes_back_and_a_new_bad_one_shows_up(self):
        good = self.add("好", [card(1, 101, 1)])
        bad = self.add("坏", [card(1, 102, 2)])
        raw_ok = (self.store.dir() / f"{bad}.json").read_text(encoding="utf-8")
        self.break_map(bad, "json")
        self.assertEqual([s["id"] for s in self.store.index().skipped], [bad])
        (self.store.dir() / f"{bad}.json").write_text(raw_ok + " ", encoding="utf-8")       # 修好（大小变了）
        idx = self.store.index()
        self.assertEqual((idx.skipped, set(idx.summaries)), ([], {good, bad}))
        self.assertEqual(idx.maps_for_subject(102), (bad,))
        # 好图坏掉 -> 下一次索引立刻反映，不会拿旧缓存当没事
        self.break_map(good, "too_many_works")
        idx = self.store.index()
        self.assertEqual([s["id"] for s in idx.skipped], [good])
        self.assertEqual(idx.maps_for_subject(101), ())
        # 坏图被删掉 -> 不再列
        self.assertTrue(self.store.delete(good))
        self.assertEqual(self.store.index().skipped, [])

    def test_a_failed_read_is_not_remembered(self):
        mid = self.add("甲", [card(1, 101, 1)])

        def locked(_self, map_id):
            try:
                raise PermissionError(13, "denied")
            except OSError as e:
                raise StorageError("读取导图失败：denied") from e
        with mock.patch.object(maps.MapStore, "_get", new=locked):
            idx = self.store.index()
        self.assertEqual([s["id"] for s in idx.skipped], [mid])
        idx = self.store.index()                                  # 文件没变，但读文件出错可能是暂时的，下次要重读
        self.assertEqual((idx.skipped, list(idx.summaries)), ([], [mid]))

    def test_list_api_reports_a_bad_map_as_an_error(self):
        # 列表接口遇到坏图要报错，让人看见；只有联动预选用的反向索引会跳过坏图
        self.add("好", [card(1, 101, 1)])
        bad = self.add("坏", [card(1, 102, 2)])
        self.break_map(bad, "json")
        with self.assertRaises(StorageError):
            self.store.all()
        self.assertEqual(len(self.store.index().summaries), 1)
        with self.assertRaises(StorageError):
            self.store.all()


# ---------------------------------------------------------------- 导入遇到坏文件
class TestImportErrors(TempData):
    def setUp(self):
        super().setUp()
        self.src = Path(self.temp.name) / "import"
        self.src.mkdir()
        (self.src / "a.tagnote.json").write_text(
            json.dumps(collection("好的", [card(1, 101, 1)], origin="o:1"), ensure_ascii=False), encoding="utf-8")

    def assert_reported_with_file_and_progress(self, bad_name):
        with self.assertRaises(StorageError) as cm:
            self.store.import_directory(str(self.src))
        e = cm.exception
        self.assertEqual(e.status, 400)
        self.assertIn(bad_name, e.message)                        # 哪个文件
        self.assertIn("'imported': 1", e.message)                 # 在它之前已经导入了 1 个
        self.assertEqual(len(self.store.all()), 1)                # 前面的确实落盘了
        return e

    def test_absurdly_deep_json_is_a_storage_error_not_a_raw_recursion_error(self):
        for name, text in (("z-array", "[" * 10000), ("z-object", '{"a":' * 10000)):
            with self.subTest(name=name):
                (self.src / f"{name}.tagnote.json").write_text(text, encoding="utf-8")
                e = self.assert_reported_with_file_and_progress(f"{name}.tagnote.json")
                self.assertIsInstance(e.__cause__, RecursionError)
                (self.src / f"{name}.tagnote.json").unlink()
                self._reset_cache()
                for p in self.store.dir().glob("*.json"):
                    p.unlink()                                    # 清掉上一轮导入的好图，下一轮重新数

    def test_recursion_error_raised_while_validating_is_reported_too(self):
        (self.src / "z.tagnote.json").write_text(
            json.dumps(collection("乙", [card(1, 102, 1)], origin="o:2"), ensure_ascii=False), encoding="utf-8")
        real = maps.validate
        calls = []

        def validate_then_blow_up(data):
            calls.append(1)
            if len(calls) == 2:
                raise RecursionError("maximum recursion depth exceeded")
            return real(data)
        with mock.patch.object(maps, "validate", side_effect=validate_then_blow_up):
            e = self.assert_reported_with_file_and_progress("z.tagnote.json")
        self.assertIsInstance(e.__cause__, RecursionError)

    def test_command_line_prints_the_message_instead_of_a_traceback(self):
        import contextlib
        import io
        (self.src / "z.tagnote.json").write_text("[" * 10000, encoding="utf-8")
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            maps.main(["import", str(self.src)])
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("z.tagnote.json", err.getvalue())
        self.assertIn("已完成", err.getvalue())


# ---------------------------------------------------------------- edited_at
class TestEditedAt(TempData):
    def test_create_sets_edited_at_and_ignores_client_value(self):
        data = collection("甲", [card(1, 101, 1)])
        data["edited_at"] = "1999-01-01T00:00:00Z"
        with mock.patch.object(maps, "now_iso", side_effect=clock(1)):
            s = self.store.create(data)
        self.assertEqual(s["edited_at"], "2026-10-01T12:00:00Z")
        self.assertEqual(s["edited_at"], s["updated_at"])
        self.assertEqual(self.store.get(s["id"])["edited_at"], "2026-10-01T12:00:00Z")

    def test_layout_only_patch_keeps_edited_at_but_bumps_updated_at(self):
        with mock.patch.object(maps, "now_iso", side_effect=clock(1)):
            mid = self.store.create(collection("甲", [card(1, 101, 1)]))["id"]            # 10-01
            s = self.store.patch(mid, {"layout_cache": {"terr": {"cols": 2, "rows": 1, "pos": {"1": [0, 0]}, "sig": "s"}}})  # 10-02
        self.assertEqual(s["edited_at"], "2026-10-01T12:00:00Z")
        self.assertEqual(s["updated_at"], "2026-10-02T12:00:00Z")
        raw = json.loads((self.store.dir() / f"{mid}.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["edited_at"], "2026-10-01T12:00:00Z")
        self.assertEqual(raw["updated_at"], "2026-10-02T12:00:00Z")

    def test_rename_updates_edited_at(self):
        with mock.patch.object(maps, "now_iso", side_effect=clock(1)):
            mid = self.store.create(collection("甲", [card(1, 101, 1)]))["id"]            # 10-01
            s = self.store.patch(mid, {"title": "甲改"})                                  # 10-02
        self.assertEqual((s["edited_at"], s["updated_at"]), ("2026-10-02T12:00:00Z",) * 2)

    def test_title_and_layout_in_one_patch_counts_as_edit(self):
        with mock.patch.object(maps, "now_iso", side_effect=clock(1)):
            mid = self.store.create(collection("甲", [card(1, 101, 1)]))["id"]
            s = self.store.patch(mid, {"title": "新", "layout_cache": {"terr": {"cols": 2, "rows": 1,
                                                                              "pos": {"1": [0, 0]}, "sig": "s"}}})
        self.assertEqual(s["edited_at"], "2026-10-02T12:00:00Z")

    def test_map_without_edited_at_falls_back_to_generated_at(self):
        mid = self.add("无编辑时间", [card(1, 101, 1)], generated_at="2025-12-31")
        path = self.store.dir() / f"{mid}.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw.pop("edited_at")                                                              # 文件里没有 edited_at
        path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        got = [m for m in self.store.all() if m["id"] == mid][0]
        self.assertEqual(got["edited_at"], "2025-12-31")
        self.assertEqual(self.store.index().summaries[mid]["edited_at"], "2025-12-31")
        # 只改布局缓存的 PATCH：文件里仍然没有 edited_at，摘要仍回退 generated_at
        s = self.store.patch(mid, {"layout_cache": {"terr": {"cols": 2, "rows": 1, "pos": {"1": [0, 0]}, "sig": "s"}}})
        self.assertEqual(s["edited_at"], "2025-12-31")
        self.assertNotIn("edited_at", json.loads(path.read_text(encoding="utf-8")))
        # 改名之后才有自己的 edited_at
        s = self.store.patch(mid, {"title": "无编辑时间改名"})
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["edited_at"], s["edited_at"])
        self.assertNotEqual(s["edited_at"], "2025-12-31")

    def test_no_edited_at_and_no_generated_at_is_none(self):
        data = collection("无日期", [card(1, 101, 1)])
        data["collection"].pop("generated_at")
        mid = self.store.create(data)["id"]
        path = self.store.dir() / f"{mid}.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw.pop("edited_at")
        path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        self.assertIsNone([m for m in self.store.all() if m["id"] == mid][0]["edited_at"])
        self.assertIsNone(maps.edited_at_of({"collection": {"generated_at": ""}}))
        self.assertEqual(maps.edited_at_of({"collection": {}, "edited_at": "2026-02-02"}), "2026-02-02")

    def test_import_directory_sets_edited_at(self):
        src = Path(self.temp.name) / "import"
        src.mkdir()
        (src / "x.tagnote.json").write_text(
            json.dumps(collection("导入", [card(1, 101, 1)], origin="o:1"), ensure_ascii=False), encoding="utf-8")
        with mock.patch.object(maps, "now_iso", side_effect=clock(5)):
            self.assertEqual(self.store.import_directory(str(src))["imported"], 1)
        self.assertEqual(self.store.all()[0]["edited_at"], "2026-10-05T12:00:00Z")

    def test_edited_at_in_http_summary_and_detail(self):
        from backend.v2 import router as R
        mini = FastAPI()
        mini.include_router(R.router)
        c = TestClient(mini)
        r = c.post("/v2/maps", json={"data": collection("接口图", [card(1, 101, 1)])})
        self.assertEqual(r.status_code, 201, r.text)
        mid = r.json()["id"]
        self.assertTrue(r.json()["edited_at"])
        listed = [m for m in c.get("/v2/maps").json()["items"] if m["id"] == mid][0]
        self.assertEqual(listed["edited_at"], r.json()["edited_at"])
        self.assertEqual(c.get(f"/v2/maps/{mid}").json()["edited_at"], r.json()["edited_at"])
        # 只改布局缓存的 PATCH：接口返回的摘要里 edited_at 不变
        terr = {"cols": 2, "rows": 1, "pos": {"1": [0, 0]}, "sig": "s"}
        r2 = c.patch(f"/v2/maps/{mid}", json={"layout_cache": {"terr": terr}})
        self.assertEqual(r2.json()["edited_at"], r.json()["edited_at"])


# ---------------------------------------------------------------- 覆盖和贪心（纯函数）
def fake_index(maps_spec):
    """maps_spec: {图 id: (subject_ids, char_ids, edited_at)}"""
    entries = []
    for mid, (subj, chars, edited) in maps_spec.items():
        entries.append(({"id": mid, "title": mid, "source": None, "group": None, "edited_at": edited},
                        frozenset(subj), frozenset(chars)))
    return MapIndex(entries)


class TestCover(unittest.TestCase):
    def test_match_by_work_when_character_is_not_on_the_map(self):
        # 角色被绑到续作的情况：方案把角色 111919 绑到续作 391706，登场作品里还有 349441；
        # 图里放的是正片 349441，代表角色是别人（char_id=5）。只按角色比对不上，按作品才对得上。
        idx = fake_index({"m_a": ({349441}, {5}, None)})
        self.assertEqual(maplink.cover_map({111919: [391706, 349441]}, idx), {"m_a": [111919]})
        # 只按绑定作品也要能匹配
        idx = fake_index({"m_a": ({391706}, {5}, None)})
        self.assertEqual(maplink.cover_map({111919: [391706, 349441]}, idx), {"m_a": [111919]})

    def test_match_by_char_id_alone(self):
        idx = fake_index({"m_a": ({999}, {111919}, None)})
        self.assertEqual(maplink.cover_map({111919: [391706]}, idx), {"m_a": [111919]})

    def test_no_match_is_left_out(self):
        idx = fake_index({"m_a": ({1}, {2}, None), "m_b": (set(), set(), None)})
        self.assertEqual(maplink.cover_map({10: [3], 11: []}, idx), {})

    def test_one_work_covers_every_character_who_appears_in_it(self):
        idx = fake_index({"m_a": ({7}, set(), None)})
        self.assertEqual(maplink.cover_map({3: [7], 1: [7, 8], 2: [9]}, idx), {"m_a": [1, 3]})


class TestGreedy(unittest.TestCase):
    COVERS = {"m_a": [1, 2, 3, 4, 5], "m_b": [4, 5, 6, 7], "m_c": [6, 7, 8], "m_d": [1, 2]}

    def pick(self, covers=None, edited=None, total=10, cap=8, target=0.95):
        return maplink.greedy_pick(self.COVERS if covers is None else covers, edited or {}, total, cap, target)

    def test_picks_largest_new_coverage_each_step_and_stops_when_nothing_new(self):
        # 先选 A（5 个）。再选 C：新增 6、7、8 共 3 个，比 B（只新增 6、7）多。
        # 这时 B、D 都没有新增 -> 停，共覆盖 8/10，没到 95% 也停。
        self.assertEqual(self.pick(), ["m_a", "m_c"])

    def test_gain_beats_recency(self):
        got = self.pick(edited={"m_a": 1.0, "m_b": 9.0, "m_c": 5.0, "m_d": 9.0})
        self.assertEqual(got[0], "m_a")

    def test_tie_goes_to_the_more_recently_edited(self):
        covers = {"m_a": [1, 2], "m_b": [3, 4], "m_c": [5, 6]}
        self.assertEqual(self.pick(covers, {"m_a": 1.0, "m_b": 3.0, "m_c": 2.0}, total=6), ["m_b", "m_c", "m_a"])
        self.assertEqual(self.pick(covers, {"m_a": 3.0, "m_b": 1.0, "m_c": 2.0}, total=6), ["m_a", "m_c", "m_b"])

    def test_tie_without_times_is_by_map_id_so_it_is_reproducible(self):
        covers = {"m_c": [5, 6], "m_b": [3, 4], "m_a": [1, 2]}
        self.assertEqual(self.pick(covers, {}, total=6), ["m_a", "m_b", "m_c"])
        # 有时间的排在没时间（-inf）的前面
        self.assertEqual(self.pick(covers, {"m_c": 1.0}, total=6)[0], "m_c")

    def test_gain_is_counted_against_what_is_already_covered(self):
        # B 单看有 4 个，但已被 A 覆盖了两个；D 单看只有 2 个但全是新的……这里 C 新增 3 最多
        got = self.pick()
        self.assertEqual(got[1], "m_c")

    def test_cap_stops_early(self):
        self.assertEqual(self.pick(cap=1), ["m_a"])

    def test_target_stops_once_reached(self):
        self.assertEqual(self.pick(target=0.5), ["m_a"])                  # 5/10 已达到
        self.assertEqual(self.pick(target=0.51), ["m_a", "m_c"])
        self.assertEqual(self.pick(target=1.0), ["m_a", "m_c"])           # 8/10 就没有新增了

    def test_empty_inputs(self):
        self.assertEqual(self.pick({}, total=5), [])
        self.assertEqual(self.pick(total=0), [])


# ---------------------------------------------------------------- 预选（合成库 + 接口）
class TestPreselect(TempData):
    def build(self):
        """图甲 = 101 / 102 两部（覆盖 11 人）；乙 = 103（按作品才匹配 c5、c8，char_id 99 不在题库）；
        丙 = 作品 999 不在任何人名下，但 char_id=7 在题库；丁 = 201 / 202（c10、c11）；戊 = 手写卡。
        创建顺序（= edited_at 先后）：甲、戊、丙、乙、丁，每步 1 天。"""
        with mock.patch.object(maps, "now_iso", side_effect=clock(1)):
            ids = {
                "甲": self.add("甲", [card(1, 101, 1), card(4, 102, 4)]),
                "戊": self.add("戊", [card(1), card(2)]),
                "丙": self.add("丙", [card(7, 999, 7)]),
                "乙": self.add("乙", [card(8, 103, 99)]),
                "丁": self.add("丁", [card(9, 201, 10), card(10, 202, 11)]),
            }
        self.ids = ids
        self.by_id = {v: k for k, v in ids.items()}
        return ids

    def names(self, mids):
        return [self.by_id[m] for m in mids]

    def test_full_result_shape_and_numbers(self):
        self.build()
        d = self.pre()
        self.assertEqual(d["pool_total"], 17)
        # 甲(11) -> 丁(新增 2) -> 乙(新增 c8，较新) -> 丙(c7)；全体覆盖 15，目标 0.95 达不到，选完有新增的为止
        self.assertEqual(self.names(d["picked"]), ["甲", "丁", "乙", "丙"])
        self.assertEqual(d["covered"], 15)
        self.assertEqual(d["no_map"], 2)                       # c6、c9 没有任何一张图沾边
        self.assertEqual([u["char_id"] for u in d["uncovered"]], [9, 6])           # 按热度降序
        self.assertEqual(d["errors"], [])
        self.assertEqual(set(d), {"pool_total", "picked", "covered", "maps", "uncovered", "pool", "no_map", "no_map_ids",
                                  "skipped", "errors", "warnings"})
        self.assertEqual(d["no_map_ids"], [6, 9])
        self.assertEqual(d["skipped"], [])

    def test_pool_lists_everyone_by_heat_so_the_client_can_recompute_uncovered(self):
        self.build()
        d = self.pre()
        heat = with_snapshot(lambda s: {c: s.C[c][C_HEAT] for c in range(1, 18)})
        ids = [p["char_id"] for p in d["pool"]]
        self.assertEqual(sorted(ids), list(range(1, 18)))
        self.assertEqual(ids, sorted(ids, key=lambda c: (-heat[c], c)))
        by = {p["char_id"]: p for p in d["pool"]}
        self.assertEqual(set(by[4]), {"char_id", "name", "bound_work_id", "bound_work_name"})
        self.assertEqual((by[4]["name"], by[4]["bound_work_id"], by[4]["bound_work_name"]), ("角色四", 102, "战斗番"))
        # uncovered = pool 里没被选中的图覆盖的，顺序一样
        covered = {c for m in d["maps"] if m["id"] in d["picked"] for c in m["covers"]}
        self.assertEqual(d["uncovered"], [p for p in d["pool"] if p["char_id"] not in covered])

    def test_maps_listing_has_only_covering_maps_sorted_by_coverage(self):
        self.build()
        d = self.pre()
        self.assertEqual(self.names([m["id"] for m in d["maps"]]), ["甲", "丁", "乙", "丙"])      # 戊没有覆盖，不列
        covers = {self.by_id[m["id"]]: m["covers"] for m in d["maps"]}
        self.assertEqual(covers["甲"], [1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17])
        self.assertEqual(covers["乙"], [5, 8])                 # c5 的登场作品里有 103
        self.assertEqual(covers["丙"], [7])                    # 按 char_id
        self.assertEqual(covers["丁"], [10, 11])
        first = d["maps"][0]
        self.assertEqual(set(first), {"id", "title", "group", "source", "edited_at", "covers"})
        self.assertEqual(first["title"], "甲")
        self.assertEqual(first["source"], "manual")
        self.assertTrue(first["edited_at"])

    def test_match_by_work_not_only_by_character(self):
        # 乙的作品卡 char_id=99（不在题库），只能靠 subject_id=103 对到 c5（登场 102、103）和 c8（绑定 103）
        self.build()
        d = self.pre()
        by = {self.by_id[m["id"]]: m for m in d["maps"]}
        self.assertEqual(by["乙"]["covers"], [5, 8])
        self.assertIn(8, [c for m in d["maps"] for c in m["covers"]])

    def test_tie_between_equal_gain_maps_goes_to_the_more_recently_edited(self):
        self.build()                                          # 乙(c8) 比 丙(c7) 晚创建 -> 乙 先
        d = self.pre()
        self.assertEqual(self.names(d["picked"][2:]), ["乙", "丙"])
        # 反过来：重建一遍，让丙更晚
        for mid in list(self.ids.values()):
            self.store.delete(mid)
        with mock.patch.object(maps, "now_iso", side_effect=clock(1)):
            ids = {n: self.add(n, c) for n, c in (
                ("甲", [card(1, 101, 1), card(4, 102, 4)]), ("乙", [card(8, 103, 99)]), ("丙", [card(7, 999, 7)]),
                ("丁", [card(9, 201, 10), card(10, 202, 11)]))}
        self.by_id = {v: k for k, v in ids.items()}
        d = self.pre()
        self.assertEqual(self.names(d["picked"]), ["甲", "丁", "丙", "乙"])

    def test_tie_falls_back_to_generated_at_when_edited_at_is_missing(self):
        a = self.add("A", [card(1, 101, 1)], generated_at="2025-01-01")
        b = self.add("B", [card(1, 101, 1)], generated_at="2025-06-01")
        for mid in (a, b):                                       # 文件里没有 edited_at
            path = self.store.dir() / f"{mid}.json"
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw.pop("edited_at")
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        d = self.pre(cap=1)
        self.assertEqual(d["picked"], [b])
        self.assertEqual([m["edited_at"] for m in d["maps"]], ["2025-06-01", "2025-01-01"])

    def test_cap_and_target(self):
        self.build()
        d = self.pre(cap=1)
        self.assertEqual(self.names(d["picked"]), ["甲"])
        self.assertEqual(d["covered"], 11)
        self.assertEqual(d["no_map"], 2)                         # no_map 与选了几张无关
        # 甲覆盖 11/17 = 0.647；target 0.6 够了
        d = self.pre(target=0.6)
        self.assertEqual(self.names(d["picked"]), ["甲"])
        d = self.pre(target=0.7)                                 # 甲+丁 = 13/17 = 0.765
        self.assertEqual(self.names(d["picked"]), ["甲", "丁"])
        d = self.pre(cap=3, target=1)
        self.assertEqual(len(d["picked"]), 3)
        self.assertEqual(d["covered"], 14)

    def test_uncovered_are_sorted_by_heat_and_carry_bound_work(self):
        # 只有一张图，只含 101：c4、c5 绑定 102、c6 绑定 104 等都没覆盖
        self.add("只有101", [card(1, 101, None)])
        d = self.pre()
        heat = with_snapshot(lambda s: {c: s.C[c][C_HEAT] for c in range(1, 18)})
        ids = [u["char_id"] for u in d["uncovered"]]
        self.assertEqual(ids, sorted(ids, key=lambda c: (-heat[c], c)))
        self.assertEqual(ids[0], 9)
        by = {u["char_id"]: u for u in d["uncovered"]}
        self.assertEqual(set(by[4]), {"char_id", "name", "bound_work_id", "bound_work_name"})
        self.assertEqual((by[4]["name"], by[4]["bound_work_id"], by[4]["bound_work_name"]), ("角色四", 102, "战斗番"))
        self.assertEqual((by[6]["bound_work_id"], by[6]["bound_work_name"]), (104, "恋爱番"))
        self.assertEqual(by[9]["bound_work_name"], "还没播的番")
        # 101 里的人（含 c12 绑定 101）都已覆盖
        self.assertNotIn(12, by)
        self.assertEqual(d["covered"], 11 - 2)                   # 101 的 c1,c2,c3,c12,c13-17 = 9
        self.assertEqual(d["no_map"], 17 - 9)

    def test_no_maps_at_all(self):
        d = self.pre()
        self.assertEqual((d["pool_total"], d["picked"], d["covered"], d["maps"], d["no_map"]), (17, [], 0, [], 17))
        self.assertEqual(len(d["uncovered"]), 17)

    def test_stops_when_no_new_coverage_even_if_target_not_reached(self):
        # 两张图完全重复，选了第一张后第二张没有新增
        self.add("重复1", [card(1, 101, 1)])
        self.add("重复2", [card(1, 101, 1)])
        d = self.pre(target=1)
        self.assertEqual(len(d["picked"]), 1)
        self.assertEqual(len(d["maps"]), 2)

    def test_defaults_are_cap_8_and_target_95(self):
        self.assertEqual((maplink.DEFAULT_CAP, maplink.DEFAULT_TARGET), (8, 0.95))
        # 12 张图每张只覆盖 1 个独有角色：不给 cap 就最多选 8 张
        # 题库里取 c1,c2,c3,c13..c17 都只属于作品 101，换成按 char_id 各建一张图
        for cid in (1, 2, 3, 13, 14, 15, 16, 17, 7, 10):
            self.add(f"单人{cid}", [card(1, None, cid)])
        d = self.pre()
        self.assertEqual(len(d["picked"]), 8)
        self.assertEqual(len(self.pre(cap=10, target=1)["picked"]), 10)

    def test_string_ids_on_the_cards_cover_integer_pool_ids(self):
        # 题库里 id 是整数；导入的图里同样的 id 可能写成字符串。两种写法要一样覆盖。
        def odd(wid, subject_id, char_id):
            w = card(wid, None, None)
            w.update({"subject_id": subject_id, "char_id": char_id})
            return w
        as_int = self.add("整数", [card(1, 101, None), card(2, 999, 7)])
        want = [(m["id"], m["covers"]) for m in self.pre()["maps"]]
        self.assertEqual(want[0][1][:3], [1, 2, 3])                # 101 这部里的人
        self.store.delete(as_int)
        as_str = self.add("字符串", [odd(1, "101", None), odd(2, "999", "7")])
        got = self.pre()
        self.assertEqual([m["covers"] for m in got["maps"]], [c for _, c in want])
        self.assertEqual(got["picked"], [as_str])
        self.assertIn(7, got["maps"][0]["covers"])                 # 只靠字符串 char_id "7"
        self.assertEqual(got["no_map"], 17 - len(got["maps"][0]["covers"]))
        # 布尔、小数、非数字字符串同样不算
        self.store.delete(as_str)
        self.add("不算", [odd(1, True, False), odd(2, 101.0, 7.0), odd(3, "abc", "x"), odd(4, "101.0", "1e0")])
        got = self.pre()
        self.assertEqual((got["maps"], got["picked"], got["no_map"]), ([], [], 17))

    def test_a_bad_map_does_not_fail_the_preselect_and_is_reported(self):
        self.build()
        base_d = self.pre()
        bad = self.add("坏", [card(1, 101, 1)])
        (self.store.dir() / f"{bad}.json").write_text("{坏了", encoding="utf-8")
        (self.store.dir() / "notes.json").write_text("{}", encoding="utf-8")
        d = self.pre()                                              # 不报错，坏图只是被跳过
        self.assertEqual([m["id"] for m in d["maps"]], [m["id"] for m in base_d["maps"]])
        self.assertEqual(d["picked"], base_d["picked"])
        self.assertEqual(d["covered"], base_d["covered"])
        self.assertEqual(sorted(s["id"] for s in d["skipped"]), sorted([bad, "notes"]))
        for s in d["skipped"]:
            self.assertEqual(set(s), {"id", "reason"})
            self.assertTrue(s["reason"])
        # 缓存命中时同样返回
        self.assertEqual(self.pre()["skipped"], d["skipped"])
        # 坏图修好以后不再列
        (self.store.dir() / f"{bad}.json").unlink()
        (self.store.dir() / "notes.json").unlink()
        self.assertEqual(self.pre()["skipped"], [])

    def test_validation_errors(self):
        self.build()
        for key, value, code in (("cap", 0, "bad_cap"), ("cap", 101, "bad_cap"), ("cap", 2.5, "bad_cap"),
                                 ("cap", "8", "bad_cap"), ("cap", True, "bad_cap"),
                                 ("target", 0, "bad_target"), ("target", 1.01, "bad_target"),
                                 ("target", "0.9", "bad_target"), ("target", -1, "bad_target"),
                                 ("target", False, "bad_target")):
            with self.subTest(key=key, value=value):
                r = self.post(spec=SPEC_ALL, **{key: value})
                self.assertEqual((r.status_code, r.json()["error"]), (422, code))
        r = self.post()                                          # spec、plan_name 都没给
        self.assertEqual((r.status_code, r.json()["error"]), (422, "bad_field"))
        r = self.post(plan_name=5)
        self.assertEqual((r.status_code, r.json()["error"]), (422, "bad_field"))
        r = self.post(spec={"game": {"tag_count": 11}})
        self.assertEqual((r.status_code, r.json()["error"]), (422, "bad_spec"))

    def test_empty_pool_is_422(self):
        r = self.post(spec=base.spec([]))
        self.assertEqual((r.status_code, r.json()["error"]), (422, "empty_pool"))

    def test_plan_name_reads_the_saved_plan_and_matches_the_spec_result(self):
        self.build()
        PLANS.save("联动测试方案", SPEC_ALL)
        by_spec = self.pre(spec=SPEC_ALL)
        by_plan = self.pre(spec=None, plan_name="联动测试方案")
        self.assertEqual(by_plan, by_spec)
        r = self.post(plan_name="没有这个方案")
        self.assertEqual((r.status_code, r.json()["error"]), (404, "not_found"))
        r = self.post(plan_name="../bad")
        self.assertIn(r.status_code, (400, 422))

    def test_spec_wins_over_plan_name(self):
        self.build()
        d = self.pre(spec=SPEC_ALL, plan_name="不存在的方案")
        self.assertEqual(d["pool_total"], 17)

    def test_response_pool_matches_what_a_solo_session_would_draw(self):
        from backend.v2.solo.session import pool_with_works
        from backend.v2.spec import parse_spec
        self.build()
        d = self.pre()
        pool = with_snapshot(lambda s: pool_with_works(s, parse_spec(SPEC_ALL))[1])
        self.assertEqual(d["pool_total"], len(pool))


# ---------------------------------------------------------------- 图组存储
class TestSetStore(TempData):
    def get(self, key):
        return client.get(f"/v2/maplink/sets/{quote(key, safe='')}")

    def put(self, key, ids):
        return client.put(f"/v2/maplink/sets/{quote(key, safe='')}", json={"map_ids": ids})

    def test_missing_is_404_then_put_then_get(self):
        r = self.get("workbench")
        self.assertEqual((r.status_code, r.json()["error"]), (404, "not_found"))
        r = self.put("workbench", ["m_aaaaaaaaaaaa", "m_bbbbbbbbbbbb"])
        self.assertEqual(r.status_code, 200, r.text)
        saved = r.json()
        self.assertEqual(set(saved), {"plan_key", "map_ids", "updated_at"})
        self.assertEqual((saved["plan_key"], saved["map_ids"]), ("workbench", ["m_aaaaaaaaaaaa", "m_bbbbbbbbbbbb"]))
        self.assertRegex(saved["updated_at"], r"^\d{4}-\d\d-\d\dT")
        self.assertEqual(self.get("workbench").json(), saved)
        self.assertTrue((Path(self.temp.name) / "maplink_v2" / "sets.json").is_file())

    def test_overwrite_and_empty_set_and_independent_keys(self):
        self.put("workbench", ["m_aaaaaaaaaaaa"])
        self.put("plan:方案A", ["m_bbbbbbbbbbbb"])
        r = self.put("workbench", [])
        self.assertEqual(r.json()["map_ids"], [])
        self.assertEqual(self.get("workbench").json()["map_ids"], [])             # 空图组也是「存过」
        self.assertEqual(self.get("plan:方案A").json()["map_ids"], ["m_bbbbbbbbbbbb"])

    def test_duplicates_removed_keeping_first_position(self):
        r = self.put("workbench", ["m_bbbbbbbbbbbb", "m_aaaaaaaaaaaa", "m_bbbbbbbbbbbb"])
        self.assertEqual(r.json()["map_ids"], ["m_bbbbbbbbbbbb", "m_aaaaaaaaaaaa"])

    def test_plan_key_with_chinese_and_colon_survives_url_encoding(self):
        key = "plan:方案A：战斗 加强版"           # 全角冒号和空格是合法的方案名；地址里的 plan: 冒号也要能过
        self.assertEqual(self.put(key, ["m_aaaaaaaaaaaa"]).status_code, 200)
        self.assertEqual(self.get(key).json()["plan_key"], key)
        # 没编码（冒号和中文直接放在地址里）同样能取
        r = client.get("/v2/maplink/sets/plan:方案A：战斗 加强版")
        self.assertEqual(r.json()["map_ids"], ["m_aaaaaaaaaaaa"])

    def test_bad_plan_key_or_map_ids_are_422(self):
        for key in ("other", "plan:", "plan:   ", "Plan:x", "plan: x", "plan:x ", "plan:" + "x" * 81, "plan:a:b",
                    "plan:.隐藏", "plan:a*b", "plan:CON"):
            with self.subTest(key=key):
                self.assertEqual(self.put(key, []).status_code, 422)
                self.assertEqual(self.get(key).status_code, 422)
        for ids in ("m_aaaaaaaaaaaa", [1], ["../x"], ["m_AAAAAAAAAAAA"], ["m_aaaaaaaaaaa"], [None], {"a": 1}):
            with self.subTest(ids=ids):
                r = self.put("workbench", ids)
                self.assertEqual(r.status_code, 422)
        r = client.put("/v2/maplink/sets/workbench", json={"map_ids": ["m_aaaaaaaaaaaa"] * 3 + [f"m_{i:012x}" for i in range(1001)]})
        self.assertEqual(r.status_code, 422)                      # 超过 1000 张
        r = client.put("/v2/maplink/sets/workbench", json={})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.get("workbench").status_code, 404)  # 上面全是失败的，没有写进去

    def test_body_plan_key_must_match_the_path(self):
        r = client.put("/v2/maplink/sets/workbench", json={"plan_key": "workbench", "map_ids": ["m_aaaaaaaaaaaa"]})
        self.assertEqual(r.status_code, 200)
        r = client.put("/v2/maplink/sets/workbench", json={"plan_key": "plan:别的", "map_ids": []})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.get("workbench").json()["map_ids"], ["m_aaaaaaaaaaaa"])

    def test_file_format(self):
        self.put("plan:甲", ["m_aaaaaaaaaaaa"])
        raw = json.loads((Path(self.temp.name) / "maplink_v2" / "sets.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["version"], 1)
        self.assertEqual(set(raw["sets"]["plan:甲"]), {"map_ids", "updated_at"})

    def test_corrupt_file_is_set_aside_and_treated_as_empty(self):
        d = Path(self.temp.name) / "maplink_v2"
        d.mkdir(parents=True)
        (d / "sets.json").write_text("{坏了", encoding="utf-8")
        self.assertEqual(self.get("workbench").status_code, 404)
        self.assertEqual(len(list(d.glob("sets.json.bad-*"))), 1)
        self.assertEqual(self.put("workbench", ["m_aaaaaaaaaaaa"]).status_code, 200)
        self.assertEqual(self.get("workbench").json()["map_ids"], ["m_aaaaaaaaaaaa"])
        # 形状不对（不是 {sets:{}}）同样处理
        (d / "sets.json").write_text('["x"]', encoding="utf-8")
        self.assertEqual(self.get("workbench").status_code, 404)

    def test_failed_write_keeps_the_old_file(self):
        self.put("workbench", ["m_aaaaaaaaaaaa"])
        path = Path(self.temp.name) / "maplink_v2" / "sets.json"
        before = path.read_bytes()
        with mock.patch("backend.v2.solo.session.os.replace", side_effect=OSError("injected failure")):
            with self.assertRaises(OSError):
                maplink.SETS.put("workbench", ["m_bbbbbbbbbbbb"])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.get("workbench").json()["map_ids"], ["m_aaaaaaaaaaaa"])

    # -------- 读不出来 / 备份失败：绝不能拿空底稿覆盖原文件
    def sets_path(self):
        return Path(self.temp.name) / "maplink_v2" / "sets.json"

    def bad_files(self):
        return sorted(self.sets_path().parent.glob("sets.json.bad-*"))

    def seed_two_plans(self):
        self.put("plan:甲", ["m_aaaaaaaaaaaa"])
        self.put("plan:乙", ["m_bbbbbbbbbbbb"])
        return self.sets_path().read_bytes()

    def read_fails(self):
        orig = Path.read_bytes

        def fail(path_self):
            if path_self.name == "sets.json":
                raise PermissionError(13, "injected read failure")
            return orig(path_self)
        return mock.patch.object(Path, "read_bytes", fail)

    def test_unreadable_file_is_a_500_storage_error_and_nothing_is_overwritten(self):
        before = self.seed_two_plans()
        with self.read_fails():
            r = self.get("plan:甲")
            self.assertEqual((r.status_code, r.json()["ok"], r.json()["error"]), (500, False, "storage"))
            self.assertIn("没有改动", r.json()["message"])
            r = self.put("plan:丙", ["m_cccccccccccc"])                   # 新图组也不能写
            self.assertEqual((r.status_code, r.json()["error"]), (500, "storage"))
            r = self.put("plan:甲", ["m_dddddddddddd"])
            self.assertEqual((r.status_code, r.json()["error"]), (500, "storage"))
        self.assertEqual(self.sets_path().read_bytes(), before)            # 原文件一个字节没动
        self.assertEqual(self.bad_files(), [])                             # 也没被当成「损坏」挪走
        # 读得动了以后，其他方案的图组都还在，新写入也正常
        self.assertEqual(self.get("plan:甲").json()["map_ids"], ["m_aaaaaaaaaaaa"])
        self.assertEqual(self.get("plan:乙").json()["map_ids"], ["m_bbbbbbbbbbbb"])
        self.assertEqual(self.put("plan:丙", ["m_cccccccccccc"]).status_code, 200)
        self.assertEqual(self.get("plan:乙").json()["map_ids"], ["m_bbbbbbbbbbbb"])

    def test_unreadable_is_not_confused_with_never_saved(self):
        self.assertEqual(self.get("plan:甲").status_code, 404)             # 文件不存在 = 没存过
        self.seed_two_plans()
        with self.read_fails():
            self.assertEqual(self.get("plan:没存过的").status_code, 500)    # 文件在但读不出来 ≠ 没存过

    def test_corrupt_file_with_failed_backup_is_a_500_and_the_file_is_untouched(self):
        d = self.sets_path().parent
        d.mkdir(parents=True)
        self.sets_path().write_text("{坏了", encoding="utf-8")
        before = self.sets_path().read_bytes()
        with mock.patch("backend.v2.maplink.os.replace", side_effect=PermissionError(13, "injected rename failure")):
            r = self.get("workbench")
            self.assertEqual((r.status_code, r.json()["error"]), (500, "storage"))
            self.assertIn("备份也没成功", r.json()["message"])
            r = self.put("workbench", ["m_aaaaaaaaaaaa"])
            self.assertEqual((r.status_code, r.json()["error"]), (500, "storage"))
        self.assertEqual(self.sets_path().read_bytes(), before)            # 没有被空底稿覆盖
        self.assertEqual(self.bad_files(), [])
        # 备份能做了：原文件改名留着，再当空
        self.assertEqual(self.put("workbench", ["m_aaaaaaaaaaaa"]).status_code, 200)
        self.assertEqual([p.read_bytes() for p in self.bad_files()], [before])
        self.assertEqual(self.get("workbench").json()["map_ids"], ["m_aaaaaaaaaaaa"])

    def test_corrupt_file_is_kept_next_to_the_new_one_and_repeated_damage_never_overwrites_a_backup(self):
        d = self.sets_path().parent
        d.mkdir(parents=True)
        for text in ("{第一次坏", "{第二次坏"):
            self.sets_path().write_text(text, encoding="utf-8")
            self.assertEqual(self.get("workbench").status_code, 404)       # 同一秒内连坏两次
        self.assertEqual(sorted(p.read_text(encoding="utf-8") for p in self.bad_files()), ["{第一次坏", "{第二次坏"])

    def test_other_kinds_of_corruption_are_set_aside_too(self):
        d = self.sets_path().parent
        d.mkdir(parents=True)
        for raw in (b"\xff\xfe\x00\xff", b"[" * 100000, b"", b'{"sets": []}', b'{"version": 1}', b"null"):
            with self.subTest(raw=raw[:12]):
                self.sets_path().write_bytes(raw)
                n = len(self.bad_files())
                self.assertEqual(self.get("workbench").status_code, 404)
                self.assertEqual(len(self.bad_files()), n + 1)
                self.assertFalse(self.sets_path().exists())

    def test_concurrent_puts_to_different_keys_do_not_lose_updates(self):
        keys = [f"plan:并发{i}" for i in range(12)]
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda k: maplink.SETS.put(k, [f"m_{abs(hash(k)) % 16**12:012x}"]), keys))
        for k in keys:
            self.assertIsNotNone(maplink.SETS.get(k), k)


# ---------------------------------------------------------------- 挂载
class TestMounted(unittest.TestCase):
    def test_app_includes_maplink_router(self):
        path = os.path.join(os.path.dirname(__file__), "..", "..", "app.py")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertRegex(src, r"from \.v2\.maplink_router import router as v2_maplink_router")
        self.assertRegex(src, r"app\.include_router\(v2_maplink_router\)")

    def test_routes_registered(self):
        paths = {(r.path, tuple(sorted(r.methods))) for r in maplink_router.router.routes}
        self.assertIn(("/v2/maplink/preselect", ("POST",)), paths)
        self.assertIn(("/v2/maplink/sets/{plan_key}", ("GET",)), paths)
        self.assertIn(("/v2/maplink/sets/{plan_key}", ("PUT",)), paths)


if __name__ == "__main__":
    unittest.main()
