# backend/canvas_logic.py
import math
from typing import List, Dict, Any, Tuple, Set, Optional
from collections import defaultdict
from .canvas_gen import CanvasGenerator

# ==================== 标签分组（G_1–G_4 的分档可在设置里调整，见 backend/v2/tiers.py） ====================
TAG_GROUPS = {
    "G_format": {"TV", "剧场版", "OVA", "OAD", "WEB", "动态漫画"},
    "G_1": {"恋爱", "百合", "战斗", "日常", "搞笑", "奇幻", "科幻", "治愈", "后宫", "校园", "萌"},
    "G_2": {"运动", "音乐", "偶像", "悬疑"},
    "G_3": {"热血", "青春", "3D", "推理", "机战", "萝卜", "竞技"},
    "G_4": {"猎奇", "欧美", "国产", "历史", "BL", "童年", "冒险", "女性向", "乙女", "党争", "异世界", "泡面番", "催泪", "智斗"},
    "G_source": {"漫画改", "原创", "小说改", "游戏改"},
    "G_staff": {
        "SUNRISE", "TRIGGER", "A-1Pictures", "MADHouse", "BONES", "P.A.WORKS", "MAPPA", "SHAFT", "GAINAX", 
        "J.C.STAFF", "CloverWorks", "ufotable", "StudioPierrot", "Production.I.G", "WHITEFOX", "LIDENFILMS", 
        "davidproduction", "OLM", "studiodeen", "SILVERLINK", "BrainsBase", "Lerche", "8bit", "Feel", 
        "GONZO", "WITSTUDIO", "TMS", "StudioBind", "东映"
    }
}

FORMAT_PRIORITY = ["TV", "剧场版", "OVA", "OAD", "WEB", "动态漫画"]
# 播放形式细分时，没有额外播放形式的那一组的分支名（不是标签）
REST_KEY = "其余"

def get_format_class(tags: Set[str]) -> str:
    """内部定义的播放形式大类"""
    if "TV" in tags: return "TV"
    if "剧场版" in tags: return "剧场版"
    if "OVA" in tags or "OAD" in tags: return "OVA" # 归类名为OVA
    if "WEB" in tags: return "WEB"
    if "动态漫画" in tags: return "动态漫画"
    return "其他"

class LogicBuilder:
    def __init__(self, ds, candidate_ids: List[int], include_extra_tags: bool):
        self.ds = ds
        self.include_extra = include_extra_tags
        self.raw_chars = self._load_chars(candidate_ids)
        self.chars = self._preprocess(self.raw_chars) # 合并后的角色列表
        self.root_staff_ratios = self._calc_root_staff_ratios()

    def _get_char_tags(self, cid: int) -> Set[str]:
        """获取角色的所有有效标签 (Work Tags + Source + Playback)"""
        c = self.ds.char[cid]
        tags = set()
        
        # 1. Works Tags
        wt_source = c.get("work_tags_from_char", [])
        if isinstance(wt_source, list):
            tags.update(map(str, wt_source))
        
        # 2. Additional Work Tags (Optional)
        if self.include_extra:
            awt = c.get("additional_work_tags_from_char", [])
            if isinstance(awt, list):
                for item in awt:
                    if isinstance(item, dict) and item.get("name"):
                        tags.add(str(item["name"]))

        # 3. Source Tag
        src = c.get("source_tag_from_char") or self.ds.char_source.get(cid)
        if src in TAG_GROUPS["G_source"]:
            tags.add(src)
            
        # 4. Playback Tags (Fallback from appearances if not in work tags)
        apps = self.ds.char_appear_valid.get(cid, [])
        for wid, _ in apps:
            w = self.ds.work.get(wid)
            if not w: continue
            for t in w.get("tags", set()) | w.get("meta_tags", set()):
                if t in TAG_GROUPS["G_format"]:
                    tags.add(t)
                if t in TAG_GROUPS["G_staff"]:
                    tags.add(t)
        
        return tags

    def _load_chars(self, ids: List[int]) -> List[Dict]:
        chars = []
        for cid in ids:
            if cid not in self.ds.char: continue
            c = self.ds.char[cid]
            
            # 获取有效登场作品
            valid_works = []
            apps = self.ds.char_appear_valid.get(cid, [])
            for wid, _ in apps:
                w = self.ds.work.get(wid)
                if not w: continue
                valid_works.append(w)
            
            if not valid_works: continue

            # 按年份排序
            valid_works.sort(key=lambda x: (x["year"] is None, x["year"] or 0))
            earliest_work = valid_works[0]

            chars.append({
                "id": cid,
                "name": c["name"],
                "heat": c["heat"],
                "score": c["max_score"],
                "earliest_work": earliest_work,
                "valid_works": valid_works, 
                "tags": self._get_char_tags(cid),
                "year_span_char": (c.get("earliest_year"), c.get("latest_year"))
            })
        return chars

    def _preprocess(self, raw_chars: List[Dict]) -> List[Dict]:
        # 合并逻辑：最早登场作品id完全相同，只保留 heat 最高
        groups = defaultdict(list)
        for c in raw_chars:
            groups[c["earliest_work"]["id"]].append(c)
        
        merged = []
        for _, group in groups.items():
            if len(group) == 1:
                merged.append(group[0])
            else:
                group.sort(key=lambda x: x["heat"], reverse=True)
                merged.append(group[0])
        return merged

    def _calc_root_staff_ratios(self) -> Dict[str, float]:
        """计算 Root 处拥有共有 Staff 的角色占比"""
        total = len(self.chars)
        if total == 0: return {}
        
        counts = defaultdict(int)
        for c in self.chars:
            staffs = c["tags"] & TAG_GROUPS["G_staff"]
            for s in staffs:
                counts[s] += 1
        
        shared_staff_chars = set()
        for s, count in counts.items():
            if count > 1:
                for i, c in enumerate(self.chars):
                    if s in c["tags"]:
                        shared_staff_chars.add(i)
        
        ratio = len(shared_staff_chars) / total
        return {"_global_ratio": ratio}

    def _calc_tightest_year_range(self) -> Tuple[int, int]:
        if not self.chars: return (0, 0)
        
        char_years = []
        for c in self.chars:
            ys = sorted({w["year"] for w in c["valid_works"] if w["year"] is not None})
            if ys:
                char_years.append(ys)
            
        all_years = sorted(list(set(y for ys in char_years for y in ys)))
        if not all_years: return (0,0)
        
        min_diff = float('inf')
        best_range = (all_years[0], all_years[-1])
        
        timeline = []
        for i, ys in enumerate(char_years):
            for y in ys:
                timeline.append((y, i))
        timeline.sort()
        
        n_chars = len(char_years)
        cnt = defaultdict(int)
        satisfied = 0
        left = 0
        
        for right in range(len(timeline)):
            y_right, c_idx = timeline[right]
            if cnt[c_idx] == 0:
                satisfied += 1
            cnt[c_idx] += 1
            
            while satisfied == n_chars:
                y_left, left_c_idx = timeline[left]
                diff = y_right - y_left
                
                if diff < min_diff:
                    min_diff = diff
                    best_range = (y_left, y_right)
                elif diff == min_diff:
                    if y_left < best_range[0]:
                        best_range = (y_left, y_right)
                
                cnt[left_c_idx] -= 1
                if cnt[left_c_idx] == 0:
                    satisfied -= 1
                left += 1
                
        return best_range

    def _format_year(self, y: int, full: bool) -> str:
        s = str(y)
        return s if full else s[2:]

    def build_tree(self) -> Dict:
        if not self.chars: return {}

        # 1. Root Logic
        y_min, y_max = self._calc_tightest_year_range()
        if not y_min and not y_max:
            year_str = "年份未知"
        elif y_min == y_max:
            year_str = str(y_min)
        else:
            year_str = f"{self._format_year(y_min, False)}-{self._format_year(y_max, False)}"

        # 公共标签
        common_tags = set(self.chars[0]["tags"])
        for c in self.chars[1:]:
            common_tags &= c["tags"]
        
        # 标题命名
        title_tags = []
        for t in sorted(list(common_tags & TAG_GROUPS["G_source"])): title_tags.append(t)
        
        formats = sorted(list(common_tags & TAG_GROUPS["G_format"]))
        has_tv = "TV" in formats
        has_other_format = any(f != "TV" for f in formats)
        if has_tv and not has_other_format:
            if "TV" in formats: formats.remove("TV")
        title_tags.extend(formats)
        
        for grp in ["G_staff", "G_1", "G_2", "G_3", "G_4"]:
            tags = sorted(list(common_tags & TAG_GROUPS[grp]))
            title_tags.extend(tags)
            
        root_text = f"{year_str} {' '.join(title_tags)}".strip()
        root_color_tags = title_tags

        root_node = {
            "text": root_text,
            "tags": root_color_tags,
            "type": "branch",
            "children": [],
            "residual": "",
            # 分类继承用 common_tags；_displayed_tags 只记录画面里真正显示的标签。
            "_displayed_tags": title_tags,
            "_classification_tags": list(common_tags)
        }

        # 2. 递归分裂
        if len(self.chars) == 1:
            # 保留起点，否则它的公共标签和年份会被角色信息覆盖。
            leaf = {"children": [], "_displayed_tags": title_tags}
            self._make_leaf(leaf, self.chars[0], common_tags)
            root_node["children"].append(leaf)
        else:
            self._split(root_node, self.chars, common_tags)
        
        return root_node

    def _split(self, parent_node: Dict, chars: List[Dict], inherited_tags: Set[str]):
        # 终点判断
        if len(chars) == 1:
            self._make_leaf(parent_node, chars[0], inherited_tags)
            return

        # 寻找最佳分裂维度 (传入 inherited_tags 以避免死循环)
        strategy = self._find_best_strategy(chars, inherited_tags)
        
        if not strategy:
            # 无法再分，全部转为叶子
            chars.sort(key=lambda x: (x["score"], x["earliest_work"]["year"] or 0), reverse=False)
            
            # 尝试计算共享的 G_else (同一最终分岔点下共享)
            shared_else = []
            if len(chars) > 1:
                # 统计所有人的 G_else
                # 排除规则：19, 年代
                all_defined = set().union(*TAG_GROUPS.values())
                else_counts = defaultdict(int)
                for c in chars:
                    for t in c["tags"]:
                        if t not in all_defined and "19" not in t and "年代" not in t:
                            if t not in inherited_tags: # 排除已继承的
                                else_counts[t] += 1
                
                # 至少2人共享
                for t, cnt in else_counts.items():
                    if cnt >= 2:
                        shared_else.append(t)
            
            # 生成叶子节点
            for c in chars:
                leaf = {
                    "text": "", "tags": [], "type": "char", "children": [],
                    "_displayed_tags": parent_node.get("_displayed_tags", [])
                }
                # 将共享的 G_else 传给叶子生成函数（仅用于 Residual Box 的生成逻辑）
                self._make_leaf(leaf, c, inherited_tags, shared_residual_candidates=shared_else)
                parent_node["children"].append(leaf)
            return

        # 执行分裂
        st_type = strategy[0]
        
        if st_type == 'binary':
            tag = strategy[1]
            group_a = [c for c in chars if tag in c["tags"]]
            group_not_a = [c for c in chars if tag not in c["tags"]]
            
            self._add_branch(parent_node, group_a, inherited_tags | {tag}, tag)
            self._add_branch(parent_node, group_not_a, inherited_tags, f"非{tag}")
            
        elif st_type == 'multi_set':
            tags = strategy[1]
            tag_a, tag_b = tags[0], tags[1]
            
            groups = {
                "a_only": [], "b_only": [], "both": [], "none": []
            }
            for c in chars:
                has_a = tag_a in c["tags"]
                has_b = tag_b in c["tags"]
                if has_a and has_b: groups["both"].append(c)
                elif has_a: groups["a_only"].append(c)
                elif has_b: groups["b_only"].append(c)
                else: groups["none"].append(c)
            
            set_a_count = len(groups["a_only"]) + len(groups["both"])
            intersect_cnt = len(groups["both"])
            is_high_intersect = (set_a_count > 0 and intersect_cnt >= 0.5 * set_a_count)
            
            if is_high_intersect:
                # Type: a, b, a-b, !a!b
                if groups["a_only"]: self._add_branch(parent_node, groups["a_only"], inherited_tags | {tag_a}, tag_a)
                if groups["b_only"]: self._add_branch(parent_node, groups["b_only"], inherited_tags | {tag_b}, tag_b)
                if groups["both"]:   self._add_branch(parent_node, groups["both"], inherited_tags | {tag_a, tag_b}, f"{tag_a}-{tag_b}")
                if groups["none"]:   self._add_branch(parent_node, groups["none"], inherited_tags, f"非{tag_a}-非{tag_b}")
            else:
                # Type: b, a-!b, !a!b
                grp_b_total = groups["b_only"] + groups["both"]
                if grp_b_total: self._add_branch(parent_node, grp_b_total, inherited_tags | {tag_b}, tag_b)
                if groups["a_only"]: self._add_branch(parent_node, groups["a_only"], inherited_tags | {tag_a}, f"{tag_a}-非{tag_b}")
                if groups["none"]: self._add_branch(parent_node, groups["none"], inherited_tags, f"非{tag_a}-非{tag_b}")
                
        elif st_type == 'class':
            mapping = strategy[2]
            is_subtype_split = strategy[3] if len(strategy) > 3 else False
            
            sorted_keys = []
            if is_subtype_split:
                 for k in FORMAT_PRIORITY + [REST_KEY]:
                     if k in mapping: sorted_keys.append(k)
            else:
                sorted_keys = sorted(mapping.keys(), key=lambda k: len(mapping[k]), reverse=True)
                
            for k in sorted_keys:
                sub_chars = mapping[k]
                # 注意：如果是 'source' 类型分裂，标签就是 k
                # 如果是 'format_class' 分裂，k 是 "TV"/"剧场版" 等，它们也是标签
                # 因此这里将 k 加入 inherited
                # 如果 k 是 "未知" 或「其余」，则不加入标签集合
                next_inherited = inherited_tags | {k} if k not in ("未知", REST_KEY) else inherited_tags
                self._add_branch(parent_node, sub_chars, next_inherited, k)

    def _add_branch(self, parent: Dict, chars: List[Dict], inherited: Set[str], name_suggestion: str):
        # 分支命名: 若子节点下所有角色恰好都包含某标签 X (非继承)，追加 -X
        common = set(chars[0]["tags"])
        for c in chars[1:]:
            common &= c["tags"]
        
        new_common = common - inherited
        
        suffix = ""
        extras = []
        for t in new_common:
            if t.isdigit(): continue
            extras.append(t)
        
        node_name = name_suggestion
        visible_common = set()
        for ex in sorted(extras):
             if ex != node_name and ex not in node_name:
                 node_name += f"-{ex}"
                 visible_common.add(ex)
        
        node_tags = list(inherited | new_common)
        
        child = {
            "text": node_name,
            "tags": node_tags,
            "type": "branch",
            "children": [],
            "residual": "",
            "_classification_tags": list(inherited | new_common)
        }
        # 单独分出的叶子会替换分岔格子：只把实际分类依据移到箭头；
        # 其余标签由 _make_leaf 按实际显示过的路径补全；追加在分支名里的标签不算已显示，因为这个分岔格子会被叶子替换掉。
        # 依据中的“非X”不是正向标签；OVA 大类也不能冒充 OAD 标签。
        split_tags = inherited - set(parent.get("_classification_tags", []))
        child["_displayed_tags"] = list(set(parent.get("_displayed_tags", [])) | split_tags | visible_common)
        if len(chars) == 1:
            child["_branch_label"] = name_suggestion
            child["_displayed_tags"] = list(set(parent.get("_displayed_tags", [])) | split_tags)
        self._split(child, chars, inherited | new_common)
        parent["children"].append(child)

    def _find_best_strategy(self, chars: List[Dict], inherited_tags: Set[str]) -> Optional[Tuple]:
        total = len(chars)
        if total <= 1: return None
        is_small = (total <= 4)
        
        def check_threshold(count, threshold_pct=0.25, threshold_abs=2):
            if is_small: return count >= threshold_abs
            return (count / total) >= threshold_pct

        # Helper: 只统计未继承的标签，防止死循环
        def get_tags_in_group(grp):
            cnt = defaultdict(int)
            for c in chars:
                for t in c["tags"]:
                    if t in inherited_tags: continue # SKIP INHERITED
                    if t in TAG_GROUPS[grp]:
                        cnt[t] += 1
            return cnt

        # 1. G_1 (Priority 1)
        g1_cnt = get_tags_in_group("G_1")
        valid_g1 = [(t, c) for t, c in g1_cnt.items() if check_threshold(c)]
        if valid_g1:
            # 次数并列时按标签文字定先后：c["tags"] 是 set，遍历顺序随 Python 哈希种子变，
            # 不固定的话同一方案每次重启后端分岔都可能不同。下面 G_2/G_3/G_4/制作公司同理。
            valid_g1.sort(key=lambda x: (-x[1], x[0]))
            if len(valid_g1) == 1:
                return ('binary', valid_g1[0][0])
            else:
                return ('multi_set', [valid_g1[0][0], valid_g1[1][0]])

        # 2. G_2
        g2_cnt = get_tags_in_group("G_2")
        valid_g2 = [(t, c) for t, c in g2_cnt.items() if check_threshold(c)]
        if valid_g2:
            valid_g2.sort(key=lambda x: (-x[1], x[0]))
            if len(valid_g2) == 1:
                return ('binary', valid_g2[0][0])
            else:
                return ('multi_set', [valid_g2[0][0], valid_g2[1][0]])

        # 3. G_3
        g3_cnt = get_tags_in_group("G_3")
        valid_g3 = [(t, c) for t, c in g3_cnt.items() if check_threshold(c)]
        if valid_g3:
            valid_g3.sort(key=lambda x: (-x[1], x[0]))
            if len(valid_g3) == 1:
                return ('binary', valid_g3[0][0])
            else:
                return ('multi_set', [valid_g3[0][0], valid_g3[1][0]])

        # 4. G_staff (Special Priority)
        staff_ratio = self.root_staff_ratios.get("_global_ratio", 0)
        use_staff_high = (0.75 <= staff_ratio <= 1.0)
        use_staff_mid  = (0.50 <= staff_ratio < 0.75)
        use_staff_low  = (0.25 <= staff_ratio < 0.50)
        
        check_staff_now = use_staff_high or use_staff_mid
        
        if check_staff_now:
            st = self._try_staff_split(chars, is_small, inherited_tags)
            if st: return st

        # 5. Format Class / Source (Priority 4)
        fmt_map = defaultdict(list)
        for c in chars:
            fmt_cls = get_format_class(c["tags"])
            # 防止死循环：如果该类别已经继承，就不应作为分类依据
            # 但格式大类比较特殊，通常是互斥的。如果继承了"TV"，所有子节点都是TV，只有一种key
            fmt_map[fmt_cls].append(c)
        
        # 过滤掉只有一种情况的（即无法分裂）
        fmt_valid_keys = [k for k, v in fmt_map.items() if v]
        if len(fmt_valid_keys) <= 1: 
             fmt_map = {} # 无法分裂
             fmt_valid_keys = []

        src_map = defaultdict(list)
        for c in chars:
            found = False
            for t in sorted(c["tags"]):  # 有多个来源时固定取同一个（set 顺序随哈希种子变）
                if t in TAG_GROUPS["G_source"]:
                    # 同样检查是否继承
                    if t in inherited_tags: 
                         # 如果继承了，也要记录，但后续判断len会发现只有一组
                         pass
                    src_map[t].append(c)
                    found = True
                    break
            if not found: src_map["未知"].append(c)
            
        src_valid_keys = [k for k, v in src_map.items() if v]
        if len(src_valid_keys) <= 1:
            src_map = {}
            src_valid_keys = []
        
        can_split_fmt = len(fmt_valid_keys) > 1
        can_split_src = len(src_valid_keys) > 1
        
        if can_split_fmt and not can_split_src:
            return ('class', 'format_class', fmt_map)
        if can_split_src and not can_split_fmt:
            return ('class', 'source', src_map)
        if can_split_fmt and can_split_src:
            # PK Logic
            def count_subtypes(primary_map, secondary_keys_getter):
                max_subs = 0
                for k, sub_chars in primary_map.items():
                    s_types = set()
                    for c in sub_chars:
                        s_types.add(secondary_keys_getter(c))
                    max_subs = max(max_subs, len(s_types))
                return max_subs
            
            def get_src(c):
                for t in c["tags"]:
                    if t in TAG_GROUPS["G_source"]: return t
                return ""
            def get_fmt(c): return get_format_class(c["tags"])
            
            fmt_score = count_subtypes(fmt_map, get_src)
            src_score = count_subtypes(src_map, get_fmt)
            
            if fmt_score > 3 and src_score <= 3: return ('class', 'format_class', fmt_map)
            if src_score > 3 and fmt_score <= 3: return ('class', 'source', src_map)
            if len(fmt_valid_keys) > len(src_valid_keys): return ('class', 'format_class', fmt_map)
            if len(src_valid_keys) > len(fmt_valid_keys): return ('class', 'source', src_map)
            
            def calc_std(mapping):
                counts = [len(v) for v in mapping.values()]
                if not counts: return 0
                mean = sum(counts)/len(counts)
                var = sum((x-mean)**2 for x in counts)/len(counts)
                return math.sqrt(var)
            
            if calc_std(fmt_map) < calc_std(src_map): return ('class', 'format_class', fmt_map)
            if calc_std(src_map) < calc_std(fmt_map): return ('class', 'source', src_map)
            return ('class', 'format_class', fmt_map)

        # 6. G_staff (Low Priority)
        if use_staff_low:
             st = self._try_staff_split(chars, is_small, inherited_tags)
             if st: return st
             
        # 7. G_4
        g4_cnt = get_tags_in_group("G_4")
        valid_g4 = [(t, c) for t, c in g4_cnt.items() if check_threshold(c)]
        if valid_g4:
            valid_g4.sort(key=lambda x: (-x[1], x[0]))
            if len(valid_g4) == 1:
                return ('binary', valid_g4[0][0])
            else:
                return ('multi_set', [valid_g4[0][0], valid_g4[1][0]])

        # 8. Format Subtype
        # Exclude common formats to avoid infinite loop
        common_fmts = set()
        if chars:
            common_fmts = chars[0]["tags"] & TAG_GROUPS["G_format"]
            for c in chars[1:]:
                common_fmts &= c["tags"]

        subtype_map = defaultdict(list)
        rest = []
        for c in chars:
            # Find highest priority format NOT in common_fmts
            remain = (c["tags"] & TAG_GROUPS["G_format"]) - common_fmts
            target = None
            for p in FORMAT_PRIORITY:
                if p in remain:
                    target = p
                    break
            if target:
                subtype_map[target].append(c)
            else:
                rest.append(c)

        # 必须分出两类以上才算有效分裂
        if len(subtype_map) > 1:
            # 除共有形式外没有别的播放形式的角色归入「其余」，
            # 否则这些角色所在的作品会从导图里消失。
            if rest:
                subtype_map[REST_KEY] = rest
            return ('class', 'format_subtype', subtype_map, True)

        return None

    def _try_staff_split(self, chars, is_small, inherited_tags):
        cnt = defaultdict(int)
        for c in chars:
            for t in c["tags"]:
                if t in inherited_tags: continue # SKIP INHERITED
                if t in TAG_GROUPS["G_staff"]:
                    cnt[t] += 1
        
        def check(c):
             if is_small: return c >= 2
             return (c/len(chars)) >= 0.25

        valid = [(t, c) for t, c in cnt.items() if check(c)]
        if valid:
            valid.sort(key=lambda x: (-x[1], x[0]))
            if len(valid) == 1:
                return ('binary', valid[0][0])
            else:
                return ('multi_set', [valid[0][0], valid[1][0]])
        return None

    def _make_leaf(self, node: Dict, char: Dict, inherited: Set[str], shared_residual_candidates: List[str] = None):
        # 1. Info String: Work YY-YY Score
        wname = char["earliest_work"]["name"]
        
        ey = char["year_span_char"][0] or char["earliest_work"]["year"]
        ly = char["year_span_char"][1] or ey
        
        if ey is None:
            y_str = "年份未知"
        elif ey == ly:
            y_str = str(ey)
        else:
            y_str = f"{str(ey)[2:]}-{str(ly)[2:]}"
            
        score = f"{char['score']:.1f}"
        
        # Node Text
        wid = char["earliest_work"]["id"]
        wn = char["earliest_work"]["name"]
        link = f"[[{wid} - {wn}|{wname}]]"
        node["text"] = f"{link}\n{y_str} · {score}"
        # 只提供展示资料；不参与分类、排序或同作品合并。
        node["work_id"] = wid
        node["work_name"] = wname
        node["cover_url"] = char["earliest_work"].get("cover_url", "")
        node["type"] = "char"
        node["tags"] = list(char["tags"]) # Full color
        
        # 2. Edge Label (Format & Source not in path)
        # inherited 是分类算法的状态，不能当成实际显示过的标签。
        displayed = set(node.get("_displayed_tags", []))
        fs_tags = char["tags"] & (TAG_GROUPS["G_format"] | TAG_GROUPS["G_source"])
        remain_fs = fs_tags - displayed
        
        edge_parts = [node["_branch_label"]] if node.get("_branch_label") else []
        edge_parts.extend(sorted(remain_fs & TAG_GROUPS["G_source"]))
        edge_parts.extend(t for t in FORMAT_PRIORITY if t in remain_fs)
        node["edge_label"] = "-".join(edge_parts)

        # 3. Residual Box
        # 路径里没显示过的 G_1 / G_2 / G_3 标签都要补上
        residual_tags = set()
        for grp in ["G_1", "G_2", "G_3"]:
            g_tags = char["tags"] & TAG_GROUPS[grp]
            residual_tags.update(g_tags - displayed)
        
        # 路径里没显示过的其他标签：只补和同一最终分岔点下其他角色共有的
        if shared_residual_candidates:
            # 这里的 candidates 是兄弟节点间共享的 else tag
            # 我们只取当前 char 确实拥有的那些
            for t in shared_residual_candidates:
                 if t in char["tags"] and t not in displayed:
                     residual_tags.add(t)
        
        node["residual"] = " ".join(sorted(residual_tags))

# Wrapper to generate logic 
def generate_canvas_data(ds, candidate_ids: List[int], include_extra: bool) -> Dict:
    builder = LogicBuilder(ds, candidate_ids, include_extra)
    root = builder.build_tree()
    return root
