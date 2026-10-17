"""导图导出：完整求值池、模式画像、必需标签，以及有错误的方案不能悄悄导出。"""
from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest import mock

from . import base
from backend import canvas_logic
from backend.v2 import router as R
from backend.v2.canvas import make_canvas_store
from backend.v2.store import ModeProfile


class CanvasExportTests(unittest.TestCase):
    def test_export_uses_entire_evaluated_pool_and_first_work_dedup(self):
        sp = base.spec([base.one(base.rng(rank_to=2))])
        expected = set(base.ev(sp).pool)
        with mock.patch('backend.canvas_logic.generate_canvas_data', wraps=canvas_logic.generate_canvas_data) as build:
            response = R.v2_generate_canvas({'spec': sp, 'page': 2, 'page_size': 1, 'q': '角色五'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(build.call_args.args[1]), expected)
        self.assertEqual(len(expected), 9)
        data = json.loads(response.body)
        cards = [n['text'] for n in data['nodes'] if '[[' in n.get('text', '')]
        self.assertEqual(len(cards), 3)  # 最早作品 101 / 102 / 103：最早作品相同的角色合并成一张卡
        self.assertTrue(any('百合日常番' in text for text in cards))
        self.assertTrue(any('日常番2023' in text for text in cards))
        self.assertIn('attachment;', response.headers['content-disposition'])

    def test_exclusions_apply_before_export(self):
        sp = base.spec([base.one(base.rng(rank_to=2))], excludes=[base.one(
            {'kind': 'all_characters'}, conditions=[{'type': 'char_list', 'list_id': 'l_c'}])])
        with mock.patch('backend.canvas_logic.generate_canvas_data', wraps=canvas_logic.generate_canvas_data) as build:
            response = R.v2_generate_canvas({'spec': sp})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(build.call_args.args[1]), set(base.ev(sp).pool))
        self.assertNotIn(1, build.call_args.args[1])
        self.assertNotIn(5, build.call_args.args[1])

    def test_adapter_uses_profile_appearances_not_range_bound_work(self):
        ev = base.ev(base.spec([base.one(base.rng(rank_to=2))]))
        ds = make_canvas_store(ev)
        self.assertEqual({sid for sid, _ in ds.char_appear_valid[5]}, {102, 103})
        self.assertEqual(ds.char[5]['earliest_year'], 2023)
        self.assertEqual(ds.char[5]['max_score'], 7.5)
        self.assertEqual(ds.char[5]['source_tag_from_char'], '原创')
        self.assertEqual(ds.work[103]['name'], '日常番2023')

    def test_tag_count_changes_genre_but_keeps_all_format_and_source_tags(self):
        ev = base.ev(base.spec([base.one(base.rng(rank_to=1))], n=1))
        ds = make_canvas_store(ev)
        tags = set(ds.char[1]['work_tags_from_char'])
        self.assertEqual(tags, {'百合', '漫画改', 'TV'})
        self.assertNotIn('日常', tags)
        ev6 = base.ev(base.spec([base.one(base.rng(rank_to=1))], n=6))
        self.assertIn('日常', make_canvas_store(ev6).char[1]['work_tags_from_char'])

    def test_adapter_obeys_selected_mode(self):
        original = base.ev(base.all_with())
        mp = ModeProfile('game')
        mp.prof[10] = (0, 1, 2024, 2024, 7.2, -1, '原创')
        mp.tags[10] = ('RPG', '奇幻', 'OVA', '游戏改')
        mp.apps[10] = (201,)
        ev = SimpleNamespace(snap=original.snap, mp=mp, ti=mp.tag_index(1), pool={10})
        ds = make_canvas_store(ev)
        self.assertEqual(ds.char[10]['work_tags_from_char'], ['OVA', 'RPG', '游戏改'])
        self.assertEqual(ds.char[10]['source_tag_from_char'], '原创')
        self.assertEqual(ds.work[201]['meta_tags'], {'Galgame', 'PC'})

    def test_invalid_condition_rejects_partial_pool(self):
        sp = base.spec([base.one(base.rng(), conditions=[{'type': 'char_list', 'list_id': 'missing_canvas_test'}])])
        response = R.v2_generate_canvas({'spec': sp})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.body)['error'], 'spec_has_errors')

    def test_empty_pool_is_valid_empty_canvas(self):
        response = R.v2_generate_canvas({'spec': base.spec([])})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {'nodes': [], 'edges': []})


if __name__ == '__main__':
    unittest.main()
