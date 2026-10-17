# -*- coding: utf-8 -*-
"""样例导图（examples/maps/）：仓库里的样例文件能过导图库的校验；首次运行复制默认几张、
一键载入其余、库里已有的跳过、不覆盖用户的图、标记文件生效；载入的图保留自己的分档。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from . import base  # noqa: F401  设置临时数据目录
from backend.app import app
from backend.v2 import map_samples, maps, router as R, tiers
from backend.v2.storage import StorageError

REAL = map_samples.SAMPLES_DIR
GUARD = {"X-Outsetter": "1"}
IDS = [f"m_{i:012x}" for i in range(1, 6)]
DEFAULTS = IDS[:2]
CUSTOM_TIERS = {"G_1": ["奇幻", "战斗"], "G_2": ["日常"], "G_3": ["恋爱", "搞笑"], "G_4": []}


def fake_map(title: str) -> dict:
    return {"schema": "tagnote/1",
            "collection": {"title": title, "source": "manual", "group": "2020"},
            "works": [{"id": "1", "title": "作品一", "tags": ["TV", "日常"]}],
            "tag_groups": {"G_1": ["日常"], "G_format": ["TV"]},
            "updated_at": "2026-10-15T16:00:00.000Z"}


class RealSampleFiles(unittest.TestCase):
    """仓库里带的样例文件。"""

    def test_every_sample_passes_store_validation(self):
        class Store(maps.MapStore):
            def dir(self):
                return REAL

        store = Store()
        ids = map_samples.sample_ids()
        self.assertGreater(len(ids), 0)
        self.assertEqual(len(ids), len(list(REAL.glob("*.json"))))      # 没有文件名不合规的样例
        for map_id in ids:
            with self.subTest(id=map_id):
                data = store._get(map_id)       # 和导图库读图同一条路：校验内容，要求有 updated_at
                raw = json.loads((REAL / (map_id + ".json")).read_bytes())
                self.assertEqual(raw.get("id"), map_id)
                self.assertNotIn("origin", raw["collection"])
                self.assertTrue(data["tag_groups"])

    def test_defaults_list(self):
        listed = (REAL / map_samples.DEFAULTS_FILE).read_text(encoding="utf-8").split()
        self.assertEqual(map_samples.default_ids(), listed)     # 每个 id 都有样例文件，没有重复
        self.assertTrue(5 <= len(listed) <= 8, listed)


class SampleLoading(unittest.TestCase):
    """用临时的样例目录（5 张，默认 2 张）和临时导图库。"""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="map_samples_")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.lib = root / "maps_v2"
        self.src = root / "examples"
        self.src.mkdir()
        for i, map_id in enumerate(IDS):
            self.put_sample(map_id, {**fake_map(f"样例{i}"), "id": map_id})
        (self.src / map_samples.DEFAULTS_FILE).write_text("\n".join(DEFAULTS) + "\n", encoding="utf-8")
        for patcher in (mock.patch.object(maps.MapStore, "dir", return_value=self.lib),
                        mock.patch.object(map_samples, "SAMPLES_DIR", self.src)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def put_sample(self, map_id: str, data: dict) -> None:
        (self.src / (map_id + ".json")).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def library(self) -> list[str]:
        return sorted(p.stem for p in self.lib.glob("*.json"))

    def title(self, map_id: str) -> str:
        return maps.MAPS.get(map_id)["collection"]["title"]

    def test_first_run_copies_defaults_and_writes_marker(self):
        self.assertEqual(map_samples.status(), {"total": 5, "remaining": 5})
        self.assertEqual(map_samples.seed_defaults(), 2)
        self.assertEqual(self.library(), DEFAULTS)
        self.assertTrue((self.lib / map_samples.MARKER).is_file())
        self.assertEqual(map_samples.status(), {"total": 5, "remaining": 3})
        got = maps.MAPS.get(DEFAULTS[0])
        self.assertEqual(got["updated_at"], "2026-10-15T16:00:00.000Z")     # 保留样例自己的时间
        self.assertEqual(got["tag_groups"], fake_map("")["tag_groups"])
        self.assertEqual(self.title(DEFAULTS[0]), "样例0")

    def test_marker_stops_auto_copy_after_user_deletes(self):
        map_samples.seed_defaults()
        for map_id in DEFAULTS:
            self.assertTrue(maps.MAPS.delete(map_id))
        self.assertEqual(map_samples.seed_defaults(), 0)
        self.assertEqual(self.library(), [])
        # 删掉的样例不会自己回来；它们又算进「还有 N 张」，点一键载入能重新载入
        self.assertEqual(map_samples.status()["remaining"], 5)
        self.assertEqual(map_samples.load_all()["loaded"], 5)
        self.assertEqual(self.library(), IDS)

    def test_library_with_maps_is_not_seeded_and_check_runs_once(self):
        mine = maps.MAPS.create(fake_map("我的图"))["id"]
        self.assertEqual(map_samples.seed_defaults(), 0)
        self.assertEqual(self.library(), [mine])
        self.assertTrue((self.lib / map_samples.MARKER).is_file())
        maps.MAPS.delete(mine)
        self.assertEqual(map_samples.seed_defaults(), 0)       # 库空了也不自动复制
        self.assertEqual(self.library(), [])
        self.assertEqual(map_samples.status()["remaining"], 5)

    def test_load_all_copies_the_rest_once(self):
        map_samples.seed_defaults()
        self.assertEqual(map_samples.load_all(), {"loaded": 3, "skipped": 2, "total": 5, "remaining": 0})
        self.assertEqual(self.library(), IDS)
        stamps = {p.name: p.stat().st_mtime_ns for p in self.lib.glob("*.json")}
        self.assertEqual(map_samples.load_all(), {"loaded": 0, "skipped": 5, "total": 5, "remaining": 0})
        self.assertEqual({p.name: p.stat().st_mtime_ns for p in self.lib.glob("*.json")}, stamps)
        self.assertEqual(map_samples.seed_defaults(), 0)

    def test_load_all_skips_existing_ids_and_never_overwrites(self):
        map_samples.seed_defaults()
        maps.MAPS.patch(DEFAULTS[0], {"title": "我改过的"})
        with maps.MAPS._locked():       # 库里本来就有一张和样例同 id 的图（内容不同）
            maps.MAPS._write(IDS[3], maps.validate(fake_map("库里原有的图")), edited=True)
        self.assertEqual(map_samples.status()["remaining"], 2)
        self.assertEqual(map_samples.load_all(), {"loaded": 2, "skipped": 3, "total": 5, "remaining": 0})
        self.assertEqual(self.library(), IDS)
        self.assertEqual(self.title(DEFAULTS[0]), "我改过的")
        self.assertEqual(self.title(IDS[3]), "库里原有的图")
        self.assertEqual(self.title(IDS[2]), "样例2")

    def test_no_samples_directory(self):
        with mock.patch.object(map_samples, "SAMPLES_DIR", self.src / "missing"):
            self.assertEqual(map_samples.seed_defaults(), 0)
            self.assertFalse((self.lib / map_samples.MARKER).exists())
            self.assertEqual(map_samples.status(), {"total": 0, "remaining": 0})
            self.assertEqual(map_samples.load_all()["loaded"], 0)

    def test_bad_sample_names_its_id_and_keeps_what_was_copied(self):
        self.put_sample(IDS[3], {"schema": "tagnote/1", "collection": {"title": "坏的"}, "works": []})
        map_samples.seed_defaults()
        with self.assertRaises(StorageError) as caught:
            map_samples.load_all()
        self.assertIn(IDS[3], caught.exception.message)
        self.assertEqual(self.library(), IDS[:3])                   # 坏的之前那张已经复制进来
        self.assertEqual(map_samples.status()["remaining"], 2)

    def test_loaded_samples_keep_their_own_tiers(self):
        """改了分档（公式）以后，载入的样例仍然是做图时的分档。拿仓库样例里两种来源各一张。"""
        picked = {}
        for path in sorted(REAL.glob("m_*.json")):
            source = json.loads(path.read_bytes())["collection"]["source"]
            picked.setdefault(source, path)
        self.assertGreaterEqual(len(picked), 2)
        for path in self.src.glob("m_*.json"):
            path.unlink()
        for path in picked.values():
            shutil.copyfile(path, self.src / path.name)
        self.addCleanup(tiers.load)
        self.addCleanup(lambda: os.path.exists(tiers.path()) and os.remove(tiers.path()))
        tiers.save({"formula": None, "tiers": CUSTOM_TIERS})
        self.assertEqual(map_samples.load_all()["loaded"], len(picked))
        client = TestClient(app, base_url="http://127.0.0.1:8099")
        for path in picked.values():
            with self.subTest(map=path.stem):
                r = client.get(f"/v2/maps/{path.stem}")
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json()["tag_groups"], json.loads(path.read_bytes())["tag_groups"])
                self.assertNotEqual(r.json()["tag_groups"]["G_1"], CUSTOM_TIERS["G_1"])

    def test_routes_and_write_guard(self):
        client = TestClient(app, base_url="http://127.0.0.1:8099")
        self.assertEqual(client.get("/v2/map_samples").json(), {"total": 5, "remaining": 5})
        r = client.post("/v2/map_samples/load")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "missing_guard_header")
        self.assertEqual(self.library(), [])
        r = client.post("/v2/map_samples/load", headers=GUARD)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"loaded": 5, "skipped": 0, "total": 5, "remaining": 0})
        self.assertEqual(client.get("/v2/map_samples").json(), {"total": 5, "remaining": 0})
        self.assertEqual(len(client.get("/v2/maps").json()["items"]), 5)

    def test_startup_seeds_once(self):
        # 后端启动时会跑这个处理函数。这里不真的起停应用：停的时候会关掉 AI 进程池，影响别的测试。
        self.assertIn(R._seed_samples, app.router.on_startup)
        R._seed_samples()
        self.assertEqual(self.library(), DEFAULTS)
        maps.MAPS.delete(DEFAULTS[0])
        R._seed_samples()           # 重启：有标记了，不复制
        self.assertEqual(self.library(), DEFAULTS[1:])


if __name__ == "__main__":
    unittest.main()
