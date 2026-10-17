# -*- coding: utf-8 -*-
"""经典工作台的后端：有经典工作台数据时能用，没有经典工作台数据时后端照常启动、经典接口返回 503。

用一份很小的合成经典工作台数据（3 个角色、2 部作品）。方案目录和样例目录都换成临时目录，不碰仓库里的 data/plans。
不启动点击器：/autoclick/auto/start 只测没有经典工作台数据时被挡住。
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from fastapi.testclient import TestClient

from . import base  # noqa: F401  先设好测试用出题器数据库的环境变量，再导入 backend.app
from backend import classic
from backend.app import app
from backend.paths import CLASSIC_FILES, classic_paths
from backend.schemas import ConfigPayload

GUARD = {"X-Outsetter": "1"}
EVIL = "https://evil.example"
client = TestClient(app, base_url="http://127.0.0.1:8099")

ALL_CHARS_BLOCK = {"id": "b1", "kind": "char-range", "color": "red", "weight": 1.0, "enabled": True, "params": {}}
CFG_BODY = {"mode": "char-weight", "seed": 1, "blocks": [ALL_CHARS_BLOCK], "include_extra_work_tags": False}

CHARACTERS = [
    {"id": 1, "name_cn": "甲", "gender": "♀", "heat": 30, "highest_rating": 8.5, "character_tags": ["黑发"],
     "work_tags": ["TV", "日常"], "work_count": 1, "appearances": ["作品一"], "source_tags": "原创",
     "earliest_appearance": 2010, "latest_appearance": 2010},
    {"id": 2, "name_cn": "乙", "gender": "♂", "heat": 20, "highest_rating": 7.0, "character_tags": ["眼镜"],
     "work_tags": ["TV", "日常"], "work_count": 1, "appearances": ["作品一"]},
    {"id": 3, "name_cn": "丙", "gender": "♀", "heat": 10, "highest_rating": 6.0, "character_tags": ["黑发"],
     "work_tags": ["剧场版"], "work_count": 1, "appearances": ["作品二"]},
]
SUBJECTS = [
    {"id": 100, "type": 2, "name": "Work One", "name_cn": "作品一", "nsfw": False, "score": 7.5,
     "favorite": {"wish": 10, "done": 20, "doing": 5, "on_hold": 1, "dropped": 1},
     "infobox": "{{Infobox Animation\n|放送开始= 2010年4月\n}}", "tags": [{"name": "TV"}, {"name": "日常"}], "meta_tags": []},
    {"id": 101, "type": 2, "name": "Work Two", "name_cn": "作品二", "nsfw": False, "score": 6.5,
     "favorite": {"wish": 1, "done": 2, "doing": 0, "on_hold": 0, "dropped": 0},
     "infobox": "{{Infobox Animation\n|上映年度= 2011\n}}", "tags": [{"name": "剧场版"}], "meta_tags": []},
    {"id": 102, "type": 4, "name": "A Game", "name_cn": "游戏", "nsfw": False, "favorite": {}, "tags": [], "meta_tags": []},
]
APPEARANCES = [
    {"subject_id": 100, "character_id": 1, "type": 1},
    {"subject_id": 100, "character_id": 2, "type": 2},
    {"subject_id": 101, "character_id": 3, "type": 1},
]


def _write_lines(path: str, rows: list) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def _make_classic_dir(root: str) -> None:
    os.makedirs(root, exist_ok=True)
    _write_lines(os.path.join(root, CLASSIC_FILES["characters_db"]), CHARACTERS)
    _write_lines(os.path.join(root, CLASSIC_FILES["subject"]), SUBJECTS)
    _write_lines(os.path.join(root, CLASSIC_FILES["subject_characters"]), APPEARANCES)


def _cfg(data_dir: str) -> dict:
    cfg = {"classic": {"data_dir": data_dir}}
    cfg["data_paths"] = classic_paths(cfg)
    return cfg


class ClassicTestCase(unittest.TestCase):
    """每个用例前后保存、恢复 classic 模块里的全局状态，并把方案目录、样例目录换成临时目录。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="classic_test_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        saved = {k: getattr(classic, k) for k in ("CFG", "DS", "ENGINE", "REASON", "PLANS_DIR", "SAMPLES_DIR")}
        self.addCleanup(lambda: [setattr(classic, k, v) for k, v in saved.items()])
        classic.PLANS_DIR = os.path.join(self.tmp, "plans")  # 先不创建：「没有经典工作台数据时不建方案目录」也要验证
        classic.SAMPLES_DIR = os.path.join(self.tmp, "samples")


class TestWithoutClassicData(ClassicTestCase):
    def setUp(self):
        super().setUp()
        classic.init(_cfg(os.path.join(self.tmp, "no-such-dir")))

    def test_status_says_unavailable_with_reason(self):
        r = client.get("/classic/status")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body["available"])
        self.assertEqual((body["works"], body["chars"]), (0, 0))
        self.assertIn("没有经典工作台数据", body["reason"])

    def test_partial_files_count_as_missing(self):
        d = os.path.join(self.tmp, "partial")
        _make_classic_dir(d)
        os.remove(os.path.join(d, CLASSIC_FILES["subject_characters"]))
        classic.init(_cfg(d))
        self.assertFalse(classic.available())
        self.assertIn(CLASSIC_FILES["subject_characters"], classic.status()["reason"])

    def test_broken_file_does_not_stop_startup(self):
        d = os.path.join(self.tmp, "broken")
        _make_classic_dir(d)
        with open(os.path.join(d, CLASSIC_FILES["subject"]), "w", encoding="utf-8") as f:
            f.write("这不是 JSON\n")
        classic.init(_cfg(d))
        self.assertFalse(classic.available())
        self.assertIn("经典工作台数据加载失败", classic.status()["reason"])

    def test_classic_endpoints_return_503(self):
        for method, path in (("get", "/status"), ("get", "/plans"), ("get", "/plans/x"), ("get", "/tags"),
                             ("get", "/ext/plans"), ("get", "/ext/meta")):
            with self.subTest(path=path):
                r = getattr(client, method)(path)
                self.assertEqual(r.status_code, 503)
                self.assertIn("没有经典工作台数据", r.json()["detail"])
        posts = (("/preview", CFG_BODY), ("/draw", CFG_BODY), ("/candidates", {"config": CFG_BODY}),
                 ("/stats", {"config": CFG_BODY}), ("/generate_canvas", {"config": CFG_BODY}),
                 ("/plans/x", {"blocks": []}), ("/classic/samples/load", None),
                 ("/autoclick/auto/start", {"mode": "host", "config": CFG_BODY}))
        for path, body in posts:
            with self.subTest(path=path):
                r = client.post(path, headers=GUARD, json=body)
                self.assertEqual(r.status_code, 503)
        r = client.delete("/plans/x", headers=GUARD)
        self.assertEqual(r.status_code, 503)

    def test_503_does_not_create_plans_dir(self):
        client.get("/plans")
        client.get("/ext/plans")
        client.post("/classic/samples/load", headers=GUARD)
        self.assertFalse(os.path.exists(classic.PLANS_DIR))

    def test_other_pages_still_work(self):
        self.assertEqual(client.get("/v2/lists").status_code, 200)
        self.assertEqual(client.get("/autoclick/status").status_code, 200)


class TestWithClassicData(ClassicTestCase):
    def setUp(self):
        super().setUp()
        d = os.path.join(self.tmp, "classic")
        _make_classic_dir(d)
        classic.init(_cfg(d))
        self.assertTrue(classic.available(), classic.REASON)

    def test_status_counts(self):
        body = client.get("/classic/status").json()
        self.assertTrue(body["available"])
        self.assertEqual((body["works"], body["chars"]), (2, 3))  # 游戏条目（type 4）不算
        self.assertIsNone(body["reason"])
        self.assertEqual(client.get("/status").json()["chars"], 3)

    def test_preview_draw_candidates(self):
        pv = client.post("/preview", headers=GUARD, json=CFG_BODY).json()
        self.assertEqual(pv["total_candidates"], 3)
        dr = client.post("/draw", headers=GUARD, json=CFG_BODY).json()
        self.assertIn(dr["char_id"], (1, 2, 3))
        self.assertIsNotNone(dr["character"])
        cd = client.post("/candidates", headers=GUARD, json={"config": CFG_BODY, "page": 1, "page_size": 2}).json()
        self.assertEqual((cd["total"], len(cd["items"])), (3, 2))
        # 按时间排序：2010 年登场的角色排在 2011 年的前面
        self.assertEqual(cd["items"][0]["character"]["earliest_year"], 2010)

    def test_blocks_union_and_subtract(self):
        blue = {"id": "b2", "kind": "char-list", "color": "blue", "weight": 1.0, "enabled": True,
                "params": {"char_lines": "1"}}
        body = {**CFG_BODY, "blocks": [ALL_CHARS_BLOCK, blue]}
        self.assertEqual(client.post("/preview", headers=GUARD, json=body).json()["total_candidates"], 2)

    def test_stats_and_tags(self):
        st = client.post("/stats", headers=GUARD, json={"config": CFG_BODY}).json()
        self.assertEqual(st["total"], 3)
        self.assertEqual(st["by_gender"]["♀"], 2)
        tags = client.get("/tags", params={"kind": "char", "q": "黑"}).json()
        self.assertEqual([t["name"] for t in tags["items"]], ["黑发"])

    def test_meta_lists_files(self):
        meta = client.get("/ext/meta").json()
        self.assertEqual({f["key"] for f in meta["files"]}, set(CLASSIC_FILES))
        self.assertTrue(next(f for f in meta["files"] if f["key"] == "characters_db")["exists"])
        self.assertFalse(next(f for f in meta["files"] if f["key"] == "work_tags_valid")["exists"])
        # 必需 / 可选：前端据此把没提供的可选文件显示成中性提示，而不是「缺失」
        self.assertTrue(next(f for f in meta["files"] if f["key"] == "characters_db")["required"])
        self.assertFalse(next(f for f in meta["files"] if f["key"] == "work_tags_valid")["required"])

    def test_plan_save_get_list_delete(self):
        plan = {"mode": "char-weight", "seed": 7, "blocks": [ALL_CHARS_BLOCK], "include_extra_work_tags": False}
        self.assertEqual(client.post("/plans/测试方案", headers=GUARD, json=plan).json(), {"ok": True, "name": "测试方案"})
        self.assertEqual([p["name"] for p in client.get("/plans").json()["plans"]], ["测试方案"])
        got = client.get("/plans/测试方案").json()
        self.assertEqual((got["name"], got["seed"], len(got["blocks"])), ("测试方案", 7, 1))
        self.assertEqual(client.get("/ext/plans").json()["plans"][0]["block_count"], 1)
        self.assertEqual(client.delete("/plans/测试方案", headers=GUARD).json(), {"ok": True})
        self.assertEqual(client.get("/plans/测试方案").status_code, 404)

    def test_plan_names_that_escape_the_dir_are_rejected(self):
        for name in ("a%3Ab", "a%5Cb", "..", "%2E%2E%5Cx"):
            with self.subTest(name=name):
                r = client.post(f"/plans/{name}", headers=GUARD, json={"blocks": []})
                self.assertIn(r.status_code, (400, 404))
        self.assertEqual(os.listdir(classic.PLANS_DIR) if os.path.isdir(classic.PLANS_DIR) else [], [])

    def test_load_samples_adds_missing_and_keeps_existing(self):
        os.makedirs(classic.SAMPLES_DIR)
        for name in ("甲", "乙"):
            with open(os.path.join(classic.SAMPLES_DIR, f"{name}.json"), "w", encoding="utf-8") as f:
                json.dump({"name": name, "mode": "char-weight", "blocks": [], "from": "sample"}, f, ensure_ascii=False)
        self.assertEqual(client.get("/classic/status").json()["sample_plans"], 2)
        os.makedirs(classic.PLANS_DIR)
        with open(os.path.join(classic.PLANS_DIR, "甲.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "甲", "mine": True}, f, ensure_ascii=False)
        r = client.post("/classic/samples/load", headers=GUARD).json()
        self.assertEqual((r["added"], r["skipped"]), (1, 1))
        with open(os.path.join(classic.PLANS_DIR, "甲.json"), encoding="utf-8") as f:
            self.assertTrue(json.load(f).get("mine"))
        r = client.post("/classic/samples/load", headers=GUARD).json()
        self.assertEqual((r["added"], r["skipped"]), (0, 2))

    def test_shipped_samples_are_listed(self):
        classic.SAMPLES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))))), "examples", "classic-plans")
        names = {f[:-5] for f in classic.sample_files()}
        self.assertEqual(len(names), 253)
        self.assertTrue({"0101-1857", "0102-1036"} <= names)

    def test_writes_need_the_guard_header(self):
        plan = {"blocks": []}
        for headers, code in (({}, "missing_guard_header"), ({"Origin": EVIL, **GUARD}, "forbidden_origin")):
            with self.subTest(headers=headers):
                r = client.post("/plans/越权", headers=headers, json=plan)
                self.assertEqual(r.status_code, 403)
                self.assertEqual(r.json()["error"], code)
        self.assertFalse(os.path.exists(os.path.join(classic.PLANS_DIR, "越权.json")))
        r = client.post("/classic/samples/load", headers={"Origin": EVIL, **GUARD})
        self.assertEqual(r.status_code, 403)

    def test_auto_click_provider_changes_seed_each_round(self):
        cfg = ConfigPayload(**{**CFG_BODY, "seed": 5})
        provider = classic.make_provider(cfg)
        picks = [provider() for _ in range(6)]
        for cid, name, _hint in picks:
            self.assertIn(cid, (1, 2, 3))
            self.assertEqual(name, classic.DS.char[cid]["name"])
        self.assertGreater(len({p[0] for p in picks}), 1)


class TestPackagedDataFormat(ClassicTestCase):
    """经典工作台数据包的格式：作品表自带 year，标签是名字列表。"""

    def _packaged_dir(self) -> str:
        d = os.path.join(self.tmp, "packaged")
        os.makedirs(d)
        _write_lines(os.path.join(d, CLASSIC_FILES["characters_db"]), CHARACTERS)
        _write_lines(os.path.join(d, CLASSIC_FILES["subject"]), [
            {"id": 100, "type": 2, "name_cn": "作品一", "nsfw": False, "score": 7.5, "year": 2010,
             "favorite": {"wish": 10, "done": 20, "doing": 5, "on_hold": 1, "dropped": 1}, "tags": [], "meta_tags": []},
            {"id": 101, "type": 2, "name_cn": "作品二", "nsfw": False, "score": 6.5, "year": 2011,
             "favorite": {"wish": 1, "done": 2, "doing": 0, "on_hold": 0, "dropped": 0}, "tags": ["剧场版", "原创"], "meta_tags": []},
        ])
        _write_lines(os.path.join(d, CLASSIC_FILES["subject_characters"]), APPEARANCES)
        _write_lines(os.path.join(d, CLASSIC_FILES["work_tags_valid"]), [{"id": 100, "type": 2, "tags": ["TV", "日常"]}])
        with open(os.path.join(d, CLASSIC_FILES["character_source_counts"]), "w", encoding="utf-8") as f:
            json.dump([{"character_id": 2, "top": "漫画改"}, {"character_id": 3, "top": "不是来源"}], f, ensure_ascii=False)
        return d

    def test_year_field_and_tag_names_are_used(self):
        from contextlib import redirect_stdout
        from io import StringIO

        buf = StringIO()
        with redirect_stdout(buf):
            classic.init(_cfg(self._packaged_dir()))
        self.assertTrue(classic.available(), classic.REASON)
        ds = classic.DS
        self.assertEqual((ds.work[100]["year"], ds.work[101]["year"]), (2010, 2011))
        self.assertEqual(ds.work[100]["work_tags"], {"TV", "日常"})        # 有 valid 行：用 valid
        self.assertEqual(ds.work[101]["work_tags"], {"剧场版", "原创"})    # 没有 valid 行：用作品表里的标签名
        self.assertEqual(ds.char_source, {2: "漫画改"})                    # 只认四类来源
        self.assertEqual(client.post("/preview", headers=GUARD, json=CFG_BODY).json()["total_candidates"], 3)
        # 两个可选文件都在，启动日志里没有「可选数据缺失」的提示
        self.assertNotIn("可选数据缺失", buf.getvalue())

    def test_missing_optional_files_are_noted(self):
        from contextlib import redirect_stdout
        from io import StringIO

        d = self._packaged_dir()
        os.remove(os.path.join(d, CLASSIC_FILES["character_source_counts"]))
        buf = StringIO()
        with redirect_stdout(buf):
            classic.init(_cfg(d))
        self.assertTrue(classic.available(), classic.REASON)
        self.assertIn("character_source_counts", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
