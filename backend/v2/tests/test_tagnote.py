"""标签笔记：真实合成库转换、文件存储、CLI 与 HTTP 契约。"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from types import SimpleNamespace
from urllib.parse import quote

import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from . import base
from backend.v2 import maps, router as R, tagnote, tagnote_note
from backend.canvas_logic import REST_KEY, LogicBuilder
from backend.v2.canvas import make_canvas_store
from backend.v2.storage import StorageError


def sample(title='测试 "标题": 百合', origin=None, source="outsetter", group=None):
    return tagnote.make_collection([
        {"id": "101", "title": "作品一", "note": "一句备注", "tags": ["TV", "百合"],
         "years": "2018", "score": None, "subject_id": 101, "cover": "data:image/png;base64,AAAA"}
    ], title, source, origin=origin, group=group, tags_from="map")


# 领地图布局缓存的最小合法形状（sample 里只有作品 101）
TERR = {"cols": 2, "rows": 1, "pos": {"101": [0, 0]}, "sig": "s"}


class CoreTests(unittest.TestCase):
    def test_merge_years_scores_and_order(self):
        ev = base.ev(base.base_with())
        ds = make_canvas_store(ev)
        works = tagnote.works_from_store(ds, ev.pool, tag_mode="full")
        self.assertEqual([w["id"] for w in works], ["103", "101", "102", "104"])
        self.assertEqual([w["char_id"] for w in works], [5, 1, 4, 6])
        self.assertEqual([w["years"] for w in works], ["23-24", "2024", "2024", "2024"])
        ds.char[4]["max_score"] = ds.char[6]["max_score"] = 0
        ds.char[6]["earliest_year"] = ds.char[6]["latest_year"] = None
        ds.work[104]["year"] = None
        works = tagnote.works_from_store(ds, ev.pool)
        self.assertIsNone(works[-1]["score"])
        self.assertIsNone(works[-2]["score"])
        self.assertEqual(works[-1]["years"], "年份未知")
        ds.char[6]["earliest_year"] = ds.char[6]["latest_year"] = 2024
        ds.work[104]["year"] = 2024
        works = tagnote.works_from_store(ds, reversed(sorted(ev.pool)))
        self.assertEqual([w["id"] for w in works[-2:]], ["102", "104"])

    def test_map_filters_sparse_tags_full_keeps_and_formats_sources_always_survive(self):
        ev = base.ev(base.base_with())
        ds = make_canvas_store(ev)
        ds.char[1]["work_tags_from_char"] += ["声优甲", "独有标签", "OVA", "游戏改"]
        full = {w["id"]: set(w["tags"]) for w in tagnote.works_from_store(ds, ev.pool, tag_mode="full")}
        visible = {w["id"]: set(w["tags"]) for w in tagnote.works_from_store(ds, ev.pool, tag_mode="map")}
        self.assertTrue({"声优甲", "独有标签", "TV", "OVA", "漫画改", "游戏改"} <= full["101"])
        self.assertTrue({"TV", "OVA", "漫画改", "游戏改"} <= visible["101"])
        self.assertFalse({"声优甲", "独有标签"} & visible["101"])
        with self.assertRaises(ValueError):
            tagnote.works_from_store(ds, ev.pool, tag_mode="wrong")

    def test_format_subtype_split_keeps_works_without_extra_format(self):
        # 同组 8 部里 1 部多剧场版、2 部多 WEB，其余 5 部只有共有的 TV。
        # 按播放形式细分时这 5 部要归入「其余」，不能从导图里漏掉；map 口径下它们的题材标签也要保留。
        extra = {1: "剧场版", 2: "WEB", 3: "WEB"}
        char, work = {}, {}
        for cid in range(1, 9):
            char[cid] = {"name": f"角色{cid}", "heat": 10 - cid, "max_score": 6.0, "earliest_year": 2022,
                         "latest_year": 2022, "work_tags_from_char": ["恋爱", "日常", "校园", "搞笑"],
                         "source_tag_from_char": "漫画改"}
            work[100 + cid] = {"id": 100 + cid, "name": f"作品{cid}", "year": 2022, "favorites": 0,
                               "tags": {"TV"} | ({extra[cid]} if cid in extra else set()), "meta_tags": set()}
        ds = SimpleNamespace(char=char, work=work, char_source={c: "漫画改" for c in char},
                             char_appear_valid={c: [(100 + c, None)] for c in char})
        leaves, rest = set(), []

        def walk(n):
            if n.get("type") == "char":
                leaves.add(n["work_id"])
            if n.get("text") == REST_KEY:
                rest.extend(ch["work_id"] for ch in n["children"])
            for ch in n.get("children") or []:
                walk(ch)

        walk(LogicBuilder(ds, list(char), False).build_tree())
        self.assertEqual(leaves, set(work))
        self.assertEqual(sorted(rest), [104, 105, 106, 107, 108])
        for w in tagnote.works_from_store(ds, list(char), tag_mode="map"):
            self.assertTrue({"恋爱", "日常", "校园", "搞笑"} <= set(w["tags"]), w)

    def test_note_yaml_note_and_embedded_json(self):
        data = sample()
        data["layout_cache"] = {"terr": {"x": 1}}
        note = tagnote_note.make_note(data)
        fm = yaml.safe_load(note.split("---", 2)[1])
        self.assertEqual(fm["title"], data["collection"]["title"])
        self.assertEqual(fm["tagnote"], 1)
        self.assertIn("|作品一]]（一句备注）", note)
        embedded = json.loads(note.split("```tagnote\n", 1)[1].split("```", 1)[0])
        self.assertNotIn("cover", embedded["works"][0])
        self.assertEqual(embedded["layout_cache"], data["layout_cache"])
        self.assertIn("cover", data["works"][0])

    def test_note_card_without_link_is_plain_text(self):
        data = tagnote.make_collection([
            {"id": "101", "title": "作品一", "tags": ["TV"], "years": "2018", "score": 6.0, "subject_id": 101},
            {"id": "card_a1", "title": "手写卡", "tags": ["TV"], "years": "2025", "score": 5.9},
        ], "无链接", "manual", tags_from="map")
        note = tagnote_note.make_note(data)
        self.assertIn("- [[101 - 作品一|作品一]] 2018", note)
        self.assertIn("- 手写卡 2025 · 5.9", note)
        self.assertNotIn("[[ - ", note)


class TemporaryMaps(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tagnote_")
        self.addCleanup(self.temp.cleanup)
        # 只替换导图库的位置，不影响其它测试的临时 lists / plans。
        patcher = mock.patch.object(maps.MapStore, "dir", return_value=Path(self.temp.name) / "maps_v2")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = maps.MapStore()

    def assertStorage(self, status, fn, *args):
        with self.assertRaises(StorageError) as caught:
            fn(*args)
        self.assertEqual(caught.exception.status, status)


class MapTests(TemporaryMaps):
    def test_crud_and_summary_order(self):
        data = sample()
        saved = self.store.create(data)
        mid = saved["id"]
        self.assertRegex(mid, r"^m_[0-9a-f]{12}$")
        self.assertEqual(set(saved), {"id", "title", "source", "group", "origin", "n_works", "common_tags",
                                      "tags_from", "generated_at", "updated_at", "edited_at"})
        got = self.store.get(mid)
        self.assertNotIn("cover", got["works"][0])
        self.assertIn("cover", data["works"][0])
        self.store.patch(mid, {"title": "新名字", "layout_cache": {"terr": TERR}})
        self.assertEqual(self.store.get(mid)["collection"]["title"], "新名字")
        self.assertEqual(self.store.get(mid)["layout_cache"], {"terr": TERR})
        for title, source, group in [("B", "manual", "2018"), ("A", "manual", "2018"),
                                      ("Z", "manual", "2017"), ("C", "batch", "1959-1978")]:
            self.store.create(sample(title, source=source, group=group))
        self.assertEqual([d["title"] for d in self.store.all()], ["Z", "A", "B", "C", "新名字"])
        self.assertTrue(self.store.delete(mid))
        self.assertFalse(self.store.delete(mid))
        self.assertIsNone(self.store.get(mid))
        self.assertStorage(404, self.store.patch, mid, {"title": "缺失"})

    def test_validation_boundaries(self):
        bad = [None, [], {}, {**sample(), "works": []}, {**sample(), "works": [sample()["works"][0]] * 201},
               {**sample(), "collection": {"title": " "}}, {**sample(), "schema": "other"}]
        for key, value in [("id", 1), ("title", ""), ("tags", "TV"), ("tags", [3])]:
            d = sample()
            d["works"][0][key] = value
            bad.append(d)
        for d in bad:
            with self.subTest(data=d):
                self.assertStorage(400, self.store.create, d)
        self.assertStorage(413, self.store.create, {**sample(), "large": "汉" * maps.MAX_BYTES})
        self.assertStorage(400, self.store.get, "../escape")
        mid = self.store.create(sample())["id"]
        for changes in ({}, {"works": []}, {"title": None}, {"layout_cache": []}):
            self.assertStorage(400, self.store.patch, mid, changes)
        d = sample()
        d["works"] = [{**d["works"][0], "id": str(i)} for i in range(200)]
        self.assertEqual(self.store.create(d)["n_works"], 200)

    def test_duplicate_ids_and_bad_layout_cache(self):
        d = sample()
        d["works"].append({**d["works"][0], "title": "作品二"})
        with self.assertRaises(StorageError) as caught:
            self.store.create(d)
        self.assertEqual(caught.exception.status, 400)
        self.assertIn("101", caught.exception.message)
        mid = self.store.create(sample())["id"]
        for terr in ([], {"cols": 2, "rows": 1}, {"cols": 0, "rows": 1, "pos": {}}, {"cols": 2, "rows": 10 ** 20, "pos": {}},
                     {"cols": True, "rows": 1, "pos": {}}, {**TERR, "pos": [[0, 0]]}, {**TERR, "pos": {"101": [2, 0]}},
                     {**TERR, "pos": {"101": [0]}}, {**TERR, "pos": {"101": [0.5, 0]}}, {**TERR, "pos": {"101": [0, -1]}}):
            with self.subTest(terr=terr):
                self.assertStorage(400, self.store.patch, mid, {"layout_cache": {"terr": terr}})
        # layout_cache 里 terr 以外的键不检查形状
        self.store.patch(mid, {"layout_cache": {"terr": TERR, "other": {"any": 1}}})
        self.assertEqual(self.store.get(mid)["layout_cache"]["terr"], TERR)

    def test_atomic_failure_and_concurrent_patches(self):
        mid = self.store.create(sample())["id"]
        before = self.store.get(mid)
        with mock.patch.object(maps.os, "replace", side_effect=OSError("injected failure")):
            with self.assertRaises(OSError):
                self.store.patch(mid, {"title": "不能写入"})
        self.assertEqual(self.store.get(mid), before)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(maps.MapStore().patch, mid, change) for change in
                       ({"title": "并发改名"}, {"layout_cache": {"terr": TERR}})]
            for f in futures:
                f.result()
        self.assertEqual(self.store.get(mid)["collection"]["title"], "并发改名")
        self.assertEqual(self.store.get(mid)["layout_cache"], {"terr": TERR})

    def test_import_origin_dedup_replace_and_existing_random_id(self):
        root = Path(self.temp.name) / "input" / "nested"
        root.mkdir(parents=True)
        path = root / "a.tagnote.json"
        origin = "笔记/2018/示例.canvas"
        path.write_text(json.dumps(sample(origin=origin), ensure_ascii=False), encoding="utf-8")
        self.assertEqual(self.store.import_directory(str(root.parent)), {"imported": 1, "skipped": 0, "replaced": 0})
        mid = "m_" + hashlib.sha1(origin.encode()).hexdigest()[:12]
        before = self.store.get(mid)
        self.assertEqual(self.store.import_directory(str(root.parent))["skipped"], 1)
        self.assertEqual(self.store.get(mid), before)
        path.write_text(json.dumps(sample("改过的图", origin=origin)), encoding="utf-8")
        self.assertEqual(self.store.import_directory(str(root.parent), True)["replaced"], 1)
        self.assertEqual(self.store.get(mid)["collection"]["title"], "改过的图")
        other_origin = "笔记/已存.canvas"
        random_id = self.store.create(sample(origin=other_origin))["id"]
        path.write_text(json.dumps(sample("保留随机 id", origin=other_origin)), encoding="utf-8")
        self.store.import_directory(str(root.parent), True)
        self.assertEqual(self.store.get(random_id)["collection"]["title"], "保留随机 id")
        path.write_text(json.dumps(sample()), encoding="utf-8")
        self.assertStorage(400, self.store.import_directory, str(root))

    def test_read_handle_cannot_race_with_replace_or_delete_on_windows(self):
        mid = self.store.create(sample())["id"]
        real_open = Path.open
        for mutation in (lambda: self.store.patch(mid, {"title": "读后改名"}), lambda: self.store.delete(mid)):
            opened, release, started = threading.Event(), threading.Event(), threading.Event()

            @contextmanager
            def held_read(path, *args, **kwargs):
                with real_open(path, *args, **kwargs) as f:
                    if path.suffix == ".json" and args == ("rb",) and not opened.is_set():
                        opened.set()
                        if not release.wait(5):
                            raise AssertionError("reader release timed out")
                    yield f

            def mutate():
                started.set()
                return mutation()

            with mock.patch.object(Path, "open", held_read), ThreadPoolExecutor(max_workers=2) as pool:
                reader = pool.submit(self.store.get, mid)
                self.assertTrue(opened.wait(5))
                writer = pool.submit(mutate)
                try:
                    self.assertTrue(started.wait(5))
                    # Windows 下读句柄仍打开；写者应等待读者，而非直接失败。
                    with self.assertRaises(FutureTimeoutError):
                        writer.result(timeout=0.05)
                finally:
                    release.set()
                self.assertEqual(reader.result()["id"], mid)
                writer.result()

    def test_cli_and_cross_process_lock(self):
        root = Path(self.temp.name) / "cli_input"
        root.mkdir()
        path = root / "a.tagnote.json"
        path.write_text(json.dumps(sample(origin="示例.canvas")), encoding="utf-8")
        env = {**os.environ, "OUTSETTER_V2_DATA_DIR": str(Path(self.temp.name) / "cli_data"), "PYTHONIOENCODING": "utf-8"}
        cmd = [sys.executable, "-m", "backend.v2.maps", "import", str(root)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: subprocess.run(cmd, env=env, capture_output=True, encoding="utf-8"), range(2)))
        self.assertTrue(all(p.returncode == 0 for p in results), [p.stderr for p in results])
        self.assertEqual(sorted(p.stdout.strip() for p in results), ["导入 0 / 跳过 1 / 覆盖 0", "导入 1 / 跳过 0 / 覆盖 0"])
        result = subprocess.run(cmd + ["--replace-origin"], env=env, capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "导入 0 / 跳过 0 / 覆盖 1")


class RouteTests(TemporaryMaps):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(R.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def assertError(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json()["error"], code)
        self.assertIs(response.json()["ok"], False)

    def test_generate_success_merge_and_failures(self):
        sp = base.base_with()
        response = self.client.post("/v2/tagnote", json={"spec": sp, "title": "四部", "tag_mode": "map"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(len(data["works"]), 4)
        self.assertNotIn("layout_cache", data)
        self.assertEqual((data["collection"]["mode"], data["collection"]["tag_count"]), ("anime", 6))
        with mock.patch.object(tagnote, "MAX_WORKS", 4):
            self.assertEqual(self.client.post("/v2/tagnote", json={"spec": sp}).status_code, 200)
        with mock.patch.object(tagnote, "MAX_WORKS", 3):
            r = self.client.post("/v2/tagnote", json={"spec": sp})
            self.assertError(r, 409, "too_many_works")
            self.assertEqual((r.json()["count"], r.json()["limit"]), (4, 3))
        self.assertError(self.client.post("/v2/tagnote", json={"spec": base.spec()}), 409, "empty_pool")
        # 候选池不空，但这些角色没有可用的最早作品。
        no_works = base.all_with({"type": "char_heat", "min": 900})
        self.assertTrue(base.ev(no_works).pool)
        self.assertError(self.client.post("/v2/tagnote", json={"spec": no_works}), 409, "empty_pool")
        broken = base.spec([base.one({"kind": "char_list", "list_id": "l_missing_tagnote"})])
        self.assertError(self.client.post("/v2/tagnote", json={"spec": broken}), 409, "spec_has_errors")
        self.assertError(self.client.post("/v2/tagnote", json={"spec": {"game": {"tag_count": 11}}}), 422, "bad_spec")
        self.assertError(self.client.post("/v2/tagnote", json={"spec": sp, "tag_mode": "bogus"}), 422, "bad_tag_mode")
        self.assertError(self.client.post("/v2/tagnote", json={"spec": sp, "title": " "}), 422, "bad_title")
        self.assertEqual(self.client.post("/v2/tagnote", json={"spec": sp, "tag_mode": "full"}).json()["collection"]["tags_from"], "full")

    def test_note_post_success_and_failure(self):
        data = sample()
        r = self.client.post("/v2/tagnote/note", json={"data": data})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "text/markdown; charset=utf-8")
        self.assertEqual(r.headers["content-disposition"], "attachment; filename*=UTF-8''" + quote(tagnote_note.note_filename(data["collection"]["title"]), safe=""))
        self.assertIn("|作品一]]（一句备注）", r.text)
        self.assertNotIn("data:image", r.text)
        self.assertError(self.client.post("/v2/tagnote/note", json={"data": {}}), 400, "storage")

    def test_map_routes_success_and_failure(self):
        r = self.client.post("/v2/maps", json={"data": sample()})
        self.assertEqual(r.status_code, 201, r.text)
        mid = r.json()["id"]
        url = "/v2/maps/" + mid
        self.assertError(self.client.post("/v2/maps", json={"data": {}}), 400, "storage")
        self.assertEqual(self.client.get("/v2/maps").json(), {"items": [r.json()]})
        # GET 列表无请求参数；损坏的存储文件是它的失败路径。
        corrupt = self.store.dir() / "m_000000000000.json"
        corrupt.write_text("not json", encoding="utf-8")
        self.assertError(self.client.get("/v2/maps"), 400, "storage")
        corrupt.write_text(json.dumps(self.store.get(mid)), encoding="utf-8")
        self.assertEqual(self.client.get(url).json()["works"][0]["id"], "101")
        self.assertError(self.client.get("/v2/maps/m_ffffffffffff"), 404, "not_found")
        r = self.client.patch(url, json={"title": "新图", "layout_cache": {"terr": TERR}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["title"], "新图")
        self.assertError(self.client.patch(url, json={"title": ""}), 400, "storage")
        self.assertError(self.client.patch("/v2/maps/m_ffffffffffff", json={"title": "新图"}), 404, "storage")
        r = self.client.get(url + "/note")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-disposition"], "attachment; filename*=UTF-8''%E6%96%B0%E5%9B%BE.md")
        self.assertIn('"terr"', r.text)
        self.assertError(self.client.get("/v2/maps/m_ffffffffffff/note"), 404, "not_found")
        self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertEqual(self.client.delete(url).content[:1], b"{")
        self.assertError(self.client.delete(url), 404, "not_found")
