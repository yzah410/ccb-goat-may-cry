# -*- coding: utf-8 -*-
"""单人版接口（backend/v2/solo/router.py）：用 FastAPI TestClient + 合成库。

不 import backend.app（它会载入一堆别的东西）：这里搭一个只挂 solo 路由的小 app；
backend/app.py 有没有挂上，用文本检查。
"""
from __future__ import annotations

import os
import re
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from . import base
from backend.v2.solo.router import router as solo_router

app = FastAPI()
app.include_router(solo_router)
client = TestClient(app)

SPEC_RANK2 = base.spec([base.one(base.rng(rank_to=2), id="r_t1")])        # 题库 9 人（见 test_router.test_evaluate）；范围 id 写死，两次请求才能比


class TestMounted(unittest.TestCase):
    def test_app_includes_solo_router(self):
        path = os.path.join(os.path.dirname(__file__), "..", "..", "app.py")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertRegex(src, r"from \.v2\.solo\.router import router as v2_solo_router")
        self.assertRegex(src, r"app\.include_router\(v2_solo_router\)")
        # 挂在 v2_router 后面（顺序不影响路径）
        self.assertLess(src.index("app.include_router(v2_router)"), src.index("app.include_router(v2_solo_router)"))

    def test_routes_registered(self):
        paths = {(r.path, tuple(sorted(r.methods))) for r in solo_router.routes}
        self.assertIn(("/v2/solo/pool", ("POST",)), paths)
        self.assertIn(("/v2/solo/feedback", ("POST",)), paths)
        self.assertIn(("/v2/solo/card", ("POST",)), paths)
        self.assertTrue(any(p == "/v2/solo/work_characters/{subject_id}" for p, _ in paths))


class TestPool(unittest.TestCase):
    def test_pool_ids_sorted_and_counted(self):
        r = client.post("/v2/solo/pool", json={"spec": SPEC_RANK2})
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(d["total"], 9)
        self.assertEqual(len(d["ids"]), 9)
        self.assertEqual(d["ids"], sorted(d["ids"]))
        self.assertEqual(d["mode"], "anime")
        self.assertEqual(d["tag_count"], 6)
        self.assertEqual(d["errors"], [])
        # 题库里每个人要么有登场作品，要么列在 empty_grid_ids 里
        self.assertTrue(set(d["empty_grid_ids"]) <= set(d["ids"]))

    def test_pool_accepts_bare_spec(self):
        a = client.post("/v2/solo/pool", json=SPEC_RANK2).json()
        b = client.post("/v2/solo/pool", json={"spec": SPEC_RANK2}).json()
        self.assertEqual(a["ids"], b["ids"])

    def test_pool_matches_evaluate(self):
        d = client.post("/v2/solo/pool", json={"spec": SPEC_RANK2}).json()
        self.assertEqual(set(d["ids"]), base.pool(SPEC_RANK2))

    def test_pool_empty_spec(self):
        d = client.post("/v2/solo/pool", json={"spec": base.spec([])}).json()
        self.assertEqual((d["total"], d["ids"]), (0, []))

    def test_pool_bad_spec_422_chinese(self):
        r = client.post("/v2/solo/pool", json={"spec": {"game": {"tag_count": 11}}})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"], "bad_spec")
        self.assertIn("标签数", r.json()["message"])


class TestFeedback(unittest.TestCase):
    def post(self, **kw):
        return client.post("/v2/solo/feedback", json=kw)

    def test_hand_computed_c1_vs_c2(self):
        r = self.post(guess_id=1, answer_id=2, mode="anime", subject_tag_num=6, character_tag_num=4)
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual((d["guess_id"], d["answer_id"], d["mode"]), (1, 2, "anime"))
        self.assertFalse(d["correct"])
        self.assertEqual(d["gender"], {"guess": "female", "feedback": "yes"})
        self.assertEqual(d["popularity"], {"guess": 550, "feedback": "++"})        # 550-320=230 > 320*0.2
        for k in ("rating", "shared_appearances", "appearancesCount", "metaTags", "latestAppearance",
                  "earliestAppearance", "display"):
            self.assertIn(k, d)
        self.assertEqual(d["shared_appearances"]["count"], 1)                       # 都出演 101
        self.assertEqual(d["display"]["shared_work"]["name"], "百合日常番")

    def test_defaults_are_anime_6_4(self):
        a = self.post(guess_id=1, answer_id=2).json()
        b = self.post(guess_id=1, answer_id=2, mode="anime", subject_tag_num=6, character_tag_num=4).json()
        self.assertEqual(a, b)
        self.assertEqual((a["subject_tag_num"], a["character_tag_num"]), (6, 4))

    def test_correct_flag(self):
        self.assertTrue(self.post(guess_id=5, answer_id=5).json()["correct"])

    def test_special_game_shared(self):
        d = self.post(guess_id=5, answer_id=1, subject_tag_num=4).json()
        self.assertEqual(d["shared_appearances"]["count"], 1)                       # 只共有特殊游戏 202
        self.assertEqual(d["shared_appearances"]["firstOriginal"], None)           # 上游字段和上游一致：特殊游戏没有名字
        self.assertEqual(d["shared_appearances"]["firstCn"], None)
        # display 里补上游戏名（猜猜呗游戏界面这里是空的绿块）：c5 和 c1 唯一共同的是特殊游戏 202「某 RPG」
        self.assertEqual(d["display"]["shared_work"], {"name": "某 RPG", "name_original": "某 RPG", "count": 1})

    def test_unknown_character_404(self):
        r = self.post(guess_id=999999, answer_id=1)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"], "not_found")
        self.assertNotIn("999999", r.json()["message"])                  # 错误信息不带 id（它可能是一局的答案）
        r = self.post(guess_id=1, answer_id=999999)
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("999999", r.json()["message"])

    def test_bad_inputs_422(self):
        self.assertEqual(self.post(guess_id=1, answer_id=2, mode="nope").status_code, 422)
        self.assertEqual(self.post(guess_id=1, answer_id=2, subject_tag_num=11).status_code, 422)
        self.assertEqual(self.post(guess_id=1, answer_id=2, character_tag_num=-1).status_code, 422)
        r = self.post(guess_id="1", answer_id=2)
        self.assertEqual(r.status_code, 422)
        self.assertIn("guess_id", r.json()["message"])
        self.assertEqual(self.post(answer_id=2).status_code, 422)
        self.assertEqual(self.post(guess_id=True, answer_id=2).status_code, 422)

    def test_mode_without_profile_rows(self):
        # 合成库只有 anime 画像：其它模式没有画像行，也要能出结果（登场数 0）
        d = self.post(guess_id=1, answer_id=2, mode="game").json()
        self.assertEqual(d["appearancesCount"]["guess"], 0)
        self.assertFalse(d["display"]["has_profile"])


class TestWorkCharacters(unittest.TestCase):
    def get(self, sid, **q):
        return client.get(f"/v2/solo/work_characters/{sid}", params=q)

    def test_sorted_main_first_then_heat(self):
        r = self.get(101)
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(d["subject"]["id"], 101)
        self.assertEqual(d["subject"]["name"], "百合日常番")
        self.assertEqual(d["mode"], "anime")
        self.assertEqual(d["total"], len(d["items"]))
        ids = [it["id"] for it in d["items"]]
        # 主角 c1 c2 c13-c17（按热度 500 300 10 9 8 7 6），再是配角 c3（100）、客串 c12（70）
        self.assertEqual(ids, [1, 2, 13, 14, 15, 16, 17, 3, 12])
        first = d["items"][0]
        self.assertEqual((first["name"], first["relation"], first["relation_code"], first["heat"], first["gender"]),
                         ("角色一", "主角", 1, 500, "♀"))
        self.assertEqual(first["n_app"], 1)
        self.assertEqual(d["items"][-1]["relation"], "客串")

    def test_n_app_follows_mode(self):
        # 游戏模式没有画像行：n_app = 0（游戏里这些格子是空的）
        d = self.get(101, mode="game").json()
        self.assertEqual({it["n_app"] for it in d["items"]}, {0})

    def test_characters_without_profile(self):
        d = self.get(106).json()                       # c8 在 NSFW 作品里：作品库里有，画像里没有
        self.assertEqual([it["id"] for it in d["items"]], [8])
        self.assertEqual(d["items"][0]["n_app"], 1)    # 画像里登场数 1（来自 103）

    def test_unknown_subject_404(self):
        r = self.get(987654)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"], "not_found")

    def test_bad_mode_422(self):
        self.assertEqual(self.get(101, mode="nope").status_code, 422)

    def test_bad_subject_id_422(self):
        self.assertEqual(self.get("abc").status_code, 422)        # FastAPI 自己的参数校验


class TestCard(unittest.TestCase):
    def card(self, cid, spec=SPEC_RANK2):
        return client.post("/v2/solo/card", json={"spec": spec, "char_id": cid})

    def test_card_in_pool(self):
        r = self.card(1)
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(d["char_id"], 1)
        self.assertEqual(d["character"]["name"], "角色一")
        self.assertEqual(d["character"]["gender"], "♀")
        self.assertEqual(d["grid"]["n_app"], 1)
        self.assertTrue(d["ranges"])                      # 在方案的某个范围里
        self.assertIn("has_anime", d)
        self.assertEqual(d["bound_work"]["id"], 101)

    def test_card_outside_pool_still_works(self):
        pool = base.pool(SPEC_RANK2)
        self.assertNotIn(7, pool)
        r = self.card(7)                                  # c7：只在没日期的作品里，不在题库
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(d["char_id"], 7)
        self.assertEqual(d["character"]["name"], "角色七")
        self.assertEqual(d["ranges"], [])
        self.assertIn("grid", d)
        self.assertIn("has_anime", d)

    def test_card_character_with_no_appearance(self):
        d = self.card(9).json()                           # c9：只在未上映作品里登场，登场数 0
        self.assertEqual(d["grid"]["n_app"], 0)
        self.assertEqual(d["ranges"], [])

    def test_card_matches_candidates_item(self):
        # 同一个方案下，题库里的人：card 和 /v2/candidates 的那一项一致
        from backend.v2 import router as R
        cand = R.v2_candidates({"spec": SPEC_RANK2, "page": 1, "page_size": 20, "sort": "heat"})
        item = next(it for it in cand["items"] if it["char_id"] == 1)
        got = self.card(1).json()
        for k in ("char_id", "character", "grid", "ranges", "vas", "char_tags", "work_tags", "appearances", "has_anime"):
            self.assertEqual(got[k], item[k], k)

    def test_card_unknown_char_404(self):
        r = self.card(999999)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"], "not_found")

    def test_card_bad_inputs(self):
        self.assertEqual(client.post("/v2/solo/card", json={"spec": SPEC_RANK2}).status_code, 422)
        self.assertEqual(client.post("/v2/solo/card", json={"spec": SPEC_RANK2, "char_id": "1"}).status_code, 422)
        r = client.post("/v2/solo/card", json={"spec": {"game": {"tag_count": 11}}, "char_id": 1})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"], "bad_spec")


if __name__ == "__main__":
    unittest.main()
