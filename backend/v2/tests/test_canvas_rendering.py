"""导图呈现：检查画面上实际显示的路径文字（不是分类用的 inherited 集合）。"""
import re
import unittest
from types import SimpleNamespace

from backend.canvas_logic import LogicBuilder, TAG_GROUPS, generate_canvas_data
from backend.canvas_gen import CanvasGenerator, LayoutNode


def store(tag_sets, years=None):
    ds = SimpleNamespace(char={}, work={}, char_source={}, char_appear_valid={})
    for cid, tags in enumerate(tag_sets, 1):
        year = years[cid - 1] if years else 2020
        wid = 100 + cid
        ds.work[wid] = {"id": wid, "name": f"作品{cid}", "year": year,
                        "tags": set(), "meta_tags": set()}
        ds.char[cid] = {"name": f"角色{cid}", "heat": 100 - cid, "max_score": 6 + cid / 10,
                        "work_tags_from_char": list(tags), "earliest_year": year, "latest_year": year}
        ds.char_appear_valid[cid] = [(wid, 1)]
    return ds


def leaves(node, path=()):
    if node.get("type") == "char":
        yield node, path
    else:
        for child in node["children"]:
            yield from leaves(child, (*path, node["text"]))


class CanvasPresentation(unittest.TestCase):
    def test_grouped_leaves_complete_every_format_and_source(self):
        ds = store([{"TV", "OVA", "原创"}, {"TV", "原创"}])
        tree = generate_canvas_data(ds, [1, 2], False)
        cards = [leaf for leaf, _ in leaves(tree)]
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0]["edge_label"], "TV-OVA")
        self.assertEqual(cards[1]["edge_label"], "TV")
        self.assertIn("原创", tree["text"])

    def test_singleton_preserves_split_reason_and_residuals(self):
        ds = store([{"TV", "恋爱", "漫画改"}, {"TV", "恋爱", "漫画改"},
                    {"剧场版", "游戏改", "奇幻", "萌"}])
        tree = generate_canvas_data(ds, [1, 2, 3], False)
        leaf = next(leaf for leaf, _ in leaves(tree) if "作品3" in leaf["text"])
        self.assertEqual(leaf["edge_label"], "非恋爱-游戏改-剧场版")
        self.assertEqual(set(leaf["residual"].split()), {"奇幻", "萌"})

    def test_singleton_source_class_preserves_basis_once(self):
        ds = store([{"TV", "漫画改"}, {"TV", "漫画改"}, {"TV", "游戏改", "萌"}])
        tree = generate_canvas_data(ds, [1, 2, 3], False)
        leaf = next(leaf for leaf, _ in leaves(tree) if "作品3" in leaf["text"])
        self.assertEqual(leaf["edge_label"], "游戏改-TV")
        self.assertEqual(leaf["residual"], "萌")

    def test_only_candidate_retains_root_and_link_alias(self):
        ds = store([{"TV", "原创", "恋爱"}])
        tree = generate_canvas_data(ds, [1], False)
        self.assertEqual(tree["type"], "branch")
        leaf = tree["children"][0]
        self.assertEqual(leaf["edge_label"], "TV")
        self.assertEqual(leaf["text"], "[[101 - 作品1|作品1]]\n2020 · 6.1")
        self.assertEqual(re.sub(r"\[\[([^|]+)\|([^\]]+)\]\]", r"\2", leaf["text"]).count("作品1"), 1)

    def test_oad_is_not_hidden_by_ova_class(self):
        ds = store([{"TV", "漫画改"}, {"OAD", "漫画改"}])
        tree = generate_canvas_data(ds, [1, 2], False)
        leaf = next(leaf for leaf, _ in leaves(tree) if "作品2" in leaf["text"])
        self.assertEqual(leaf["edge_label"], "OVA-OAD")

    def test_unknown_years_do_not_drop_candidates(self):
        ds = store([{"TV", "原创"}, {"TV", "原创"}], years=[None, 2020])
        tree = generate_canvas_data(ds, [1, 2], False)
        cards = [leaf for leaf, _ in leaves(tree)]
        self.assertEqual(len(cards), 2)
        self.assertIn("年份未知", cards[0]["text"])
        self.assertTrue(tree["text"].startswith("2020"))
        ds = store([{"TV"}], years=[None])
        self.assertTrue(generate_canvas_data(ds, [1], False)["text"].startswith("年份未知"))

    def test_visible_path_covers_required_tags(self):
        tag_sets = [
            {"TV", "OVA", "漫画改", "恋爱", "日常"},
            {"TV", "漫画改", "恋爱", "奇幻"},
            {"TV", "剧场版", "OVA", "原创", "战斗", "萌"},
            {"WEB", "游戏改", "战斗", "音乐"},
            {"剧场版", "小说改", "运动", "青春"},
            {"OAD", "原创", "推理"},
            {"TV", "游戏改", "萌"},
        ]
        tree = generate_canvas_data(store(tag_sets), list(range(1, 8)), False)
        required = set().union(*(TAG_GROUPS[g] for g in ("G_format", "G_source", "G_1", "G_2", "G_3")))
        for leaf, path in leaves(tree):
            cid = int(re.search(r"作品(\d+)", leaf["text"])[1])
            # 只核对实际文字，并排除“非恋爱”冒充“恋爱”。
            shown = set(re.split(r"[\s-]+", " ".join((*path, leaf["edge_label"], leaf["residual"])) ))
            self.assertFalse((tag_sets[cid - 1] & required) - shown, (cid, shown))

    def test_merging_same_first_work_still_keeps_hottest(self):
        ds = store([{"TV", "漫画改"}, {"TV", "原创"}])
        ds.char_appear_valid[2] = [(101, 1)]
        builder = LogicBuilder(ds, [1, 2], False)
        self.assertEqual([c["id"] for c in builder.chars], [1])



class CanvasTextCardLayout(unittest.TestCase):
    def test_year_rating_share_heading_and_only_long_titles_flow_inline(self):
        for title, separator in (("短标题", "<br>"),
                                 ("帝乃三姐妹原来很好搞定。", "<br>"),
                                 ("辉夜大小姐想让我告白～天才们的恋爱头脑战～", " ")):
            with self.subTest(title=title):
                link = f"[[123 - 很长的目标路径{title}|{title}]]"
                node = LayoutNode({"type": "char", "text": link + "\n2025 · 7.5"})
                node.calc_size()
                self.assertEqual(node.get_full_text(), f"### {link}{separator}2025 · 7.5")
                self.assertEqual((node.width, node.height), (240, 90))

    def test_only_standalone_tv_label_is_omitted(self):
        labels = ["TV", "TV-OVA", "漫画改-TV", "OVA", "非恋爱-TV"]
        tree = {"text": "范围", "children": [
            {"type": "char", "text": "作品", "edge_label": label} for label in labels
        ]}
        result = CanvasGenerator().process(tree)
        self.assertEqual([edge.get("label") for edge in result["edges"]],
                         [None, "TV-OVA", "漫画改-TV", "OVA", "非恋爱-TV"])

    def tree(self, count):
        return {"text": "范围", "children": [
            {"text": f"[[{i + 1} - 作品{i}|作品{i}]]\n2025 · 7.5", "type": "char",
             "edge_label": "游戏改-TV-OVA", "residual": "奇幻 萌",
             "cover_url": "https://example.invalid/unused.jpg"}
            for i in range(count)
        ]}

    def test_fanout_ports_keep_fixed_spacing(self):
        for count in (1, 2, 3, 6, 7, 8, 12):
            result = CanvasGenerator().process(self.tree(count))
            root = result["nodes"][0]
            branches = [edge for edge in result["edges"] if edge["fromNode"] == root["id"]]
            outer = 2 if count > 6 else 1
            expected = (["right"] if count == 1 else
                        ["top"] * outer + ["right"] * (count - 2 * outer) + ["bottom"] * outer)
            self.assertEqual([e["fromSide"] for e in branches], expected)
            nodes = {n["id"]: n for n in result["nodes"]}
            children = [nodes[e["toNode"]] for e in branches]
            for child in children:
                self.assertEqual(child["x"] - root["x"] - root["width"], 40)
            for a, b in zip(children, children[1:]):
                self.assertEqual(b["y"] - a["y"] - a["height"], 20)

    def test_text_cards_keep_edge_tags_and_right_hand_residuals(self):
        result = CanvasGenerator().process(self.tree(2))
        self.assertTrue(all(n["type"] == "text" for n in result["nodes"]))
        works = [n for n in result["nodes"] if "[[" in n["text"]]
        self.assertEqual(len(works), 2)
        nodes = {n["id"]: n for n in result["nodes"]}
        incoming = {e["toNode"]: e for e in result["edges"]}
        for work in works:
            self.assertTrue(work["text"].startswith("### [["))
            self.assertNotIn("![", work["text"])
            self.assertNotIn("<span", work["text"])
            self.assertEqual((work["width"], work["height"]), (240, 90))
            self.assertEqual(incoming[work["id"]]["label"], "游戏改-TV-OVA")
            residual = nodes[work["id"] + "_res"]
            self.assertIn("奇幻 萌", residual["text"])
            self.assertEqual(residual["x"] - work["x"] - work["width"], 30)

    def test_color_depends_only_on_main_branch(self):
        tree = {"text": "范围", "children": [
            {"text": "分支甲", "children": self.tree(2)["children"]},
            {"text": "分支乙", "children": self.tree(2)["children"]},
        ]}
        first = CanvasGenerator().process(tree)
        tree["tags"] = ["TV"]
        for branch in tree["children"]:
            branch["tags"] = ["奇幻", "漫画改"]
            for work in branch["children"]:
                work["tags"] = ["恋爱", "原创"]
        second = CanvasGenerator().process(tree)
        self.assertEqual([n["color"] for n in first["nodes"]],
                         [n["color"] for n in second["nodes"]])
        nodes = {n["id"]: n for n in second["nodes"]}
        root = second["nodes"][0]
        main = [nodes[e["toNode"]] for e in second["edges"] if e["fromNode"] == root["id"]]
        self.assertEqual(len({n["color"] for n in main}), 2)
        for branch in main:
            for edge in second["edges"]:
                if edge["fromNode"] == branch["id"]:
                    self.assertEqual(nodes[edge["toNode"]]["color"], branch["color"])

    def test_empty_and_repeated_generation(self):
        gen = CanvasGenerator()
        first = gen.process(self.tree(3))
        again = gen.process(self.tree(3))
        self.assertEqual(len(first["nodes"]), len(again["nodes"]))
        self.assertEqual(gen.process({}), {"nodes": [], "edges": []})


if __name__ == "__main__":
    unittest.main()
