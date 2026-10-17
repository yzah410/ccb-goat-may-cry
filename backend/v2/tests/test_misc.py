# -*- coding: utf-8 -*-
"""杂项：缓存上限、换库后后台重读用过的模式、方案改动说明里「作品标签筛选先后」的文字、声优中文名。"""
from __future__ import annotations

import os
import shutil
import sqlite3
import time
import unittest
from unittest import mock

from . import base
from backend.v2 import engine
from backend.v2.sentence import describe_changes
from backend.v2.spec import default_spec, parse_spec
from backend.v2.storage import LISTS
from backend.v2.store import HUB


class TestCacheLimits(unittest.TestCase):
    def test_cache_put_bounded_per_prefix(self):
        snap = HUB.current()
        for i in range(snap.CACHE_LIMITS["stats:"] + 10):
            snap.cache_put(f"stats:{i}", {"i": i})
        keys = [k for k in snap.cache if k.startswith("stats:")]
        self.assertEqual(len(keys), snap.CACHE_LIMITS["stats:"])
        self.assertIn(f"stats:{snap.CACHE_LIMITS['stats:'] + 9}", keys)      # 最新的留着
        self.assertNotIn("stats:0", keys)                                    # 最早的丢掉

    def test_eval_cache_bounded(self):
        snap = HUB.current()
        for k in range(30):
            engine.evaluate(parse_spec(base.spec([base.one(base.rng(rank_to=k + 1))])))
        self.assertLessEqual(len([k for k in snap.cache if k.startswith("eval:")]), snap.CACHE_LIMITS["eval:"])


class TestChangesWording(unittest.TestCase):
    def test_work_filter_order_change(self):
        a = default_spec()
        a["ranges"][0]["source"]["work_filter"] = {"tags": ["战斗"]}
        b = default_spec()
        b["ranges"][0]["source"]["work_filter"] = {"tags": ["战斗"]}
        b["ranges"][0]["source"]["work_filter_order"] = "after_rank"
        ch = describe_changes(parse_spec(a), parse_spec(b), LISTS.get)
        self.assertEqual(ch, ["作品标签筛选：先按作品标签筛、再排名 → 先排名、再按作品标签筛"])


class TestReloadWarmup(unittest.TestCase):
    def test_modes_rewarmed_after_db_change(self):
        copy = os.path.join(base.TMP, "warm.sqlite")
        shutil.copyfile(base.DB, copy)
        with mock.patch.dict(os.environ, {"OUTSETTER_V2_DB": copy}):
            s1 = HUB.current()
            HUB.mode(s1, "anime")
            c = sqlite3.connect(copy)
            c.execute("UPDATE character SET heat = heat + 1 WHERE id = 1")
            c.commit()
            c.close()
            os.utime(copy, None)
            s2 = HUB.current()
            self.assertIsNot(s1, s2)
            deadline = time.time() + 10
            while not s2.mode_loaded("anime") and time.time() < deadline:
                time.sleep(0.05)
            self.assertTrue(s2.mode_loaded("anime"))                         # 后台已经把动画模式读好了
        HUB.current()


class TestVaChineseName(unittest.TestCase):
    def test_va_fold_includes_person_cn(self):
        # 合成库里没有 person 表数据：只验证日文写法照常可用、不会因为没有中文名出错
        snap = HUB.current()
        self.assertIn("声优a", snap.va_fold())
        self.assertEqual(snap.va_cn(), {})


if __name__ == "__main__":
    unittest.main()
