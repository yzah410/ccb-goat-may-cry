from __future__ import annotations
from typing import Set
from .schemas import *
from .utils import normalize_ws, clamp_percent_to_rank, rank_slice

class BlockEngine:
    def __init__(self, ds):
        self.ds = ds
        # 是否在“角色的作品标签”判定中包含 additional_work_tags
        self.include_extra_work_tags: bool = False

    def set_include_extra_work_tags(self, v: bool) -> None:
        self.include_extra_work_tags = bool(v)


    def eval_block(self, blk: Block) -> Set[int]:
        if not blk.enabled:
            return set()
        if blk.kind == 'work-range':
            return self._eval_work_range(blk)
        if blk.kind == 'work-list':
            return self._eval_work_list(blk)
        if blk.kind == 'char-list':
            return self._eval_char_list(blk)
        if blk.kind == 'char-range':
            return self._eval_char_range(blk)
        return set()

    def _eval_work_range(self, blk: Block) -> Set[int]:
        p = WorkRangeBlock(**blk.params)
        y_min, y_max = p.years[0], p.years[1]
        base_works = set(self.ds.works_in_years(y_min, y_max))

        tag_groups = []
        for g in p.tag_groups:
            # work-range 下只看作品标签（kind == 'work'）
            items = [(it.name, it.color) for it in g.items if it.kind == 'work']
            if not items:
                # 该组没有任何 work 标签，忽略
                continue
            # 允许仅蓝组：具体 AND/NOT 逻辑交给 DataStore.works_by_tag_groups
            tag_groups.append(items)

        works = self.ds.works_by_tag_groups(base_works, tag_groups)
        selected: Set[int] = set()
        if p.rank_basis == 'per_year':
            for y in range(y_min, y_max+1):
                arr = self.ds.work_year_sorted.get(y, [])
                if not arr: continue
                if p.rank_value_kind == 'percent':
                    lo, hi = clamp_percent_to_rank(len(arr), p.rank_lo, p.rank_hi)
                else:
                    lo, hi = int(p.rank_lo), int(p.rank_hi)
                ids = set(rank_slice(arr, lo, hi))
                selected |= (ids & works)
        else:
            merged = []
            for y in range(y_min, y_max+1):
                merged.extend(self.ds.work_year_sorted.get(y, []))
            merged = sorted(list(set(merged)), key=lambda wid: self.ds.work[wid]['favorites'], reverse=True)
            if merged:
                if p.rank_value_kind == 'percent':
                    lo, hi = clamp_percent_to_rank(len(merged), p.rank_lo, p.rank_hi)
                else:
                    lo, hi = int(p.rank_lo), int(p.rank_hi)
                ids = set(rank_slice(merged, lo, hi))
                selected = ids & works
        char_set: Set[int] = set()
        for wid in selected:
            arr = self.ds.work_chars_main_sorted.get(wid, []) if p.roles_scope=='main' else self.ds.work_chars_all_sorted.get(wid, [])
            if not arr: continue
            if p.role_rank_kind == 'percent':
                lo, hi = clamp_percent_to_rank(len(arr), p.role_rank_lo, p.role_rank_hi)
            else:
                lo, hi = int(p.role_rank_lo), int(p.role_rank_hi)
            chunk = rank_slice(arr, lo, hi)
            if not chunk: continue
            char_set.update(chunk)
        return char_set

    def _eval_work_list(self, blk: Block) -> Set[int]:
        p = WorkListBlock(**blk.params)
        work_ids: Set[int] = set()
        for raw in p.work_lines.splitlines():
            raw = raw.strip()
            if not raw: continue
            parts = normalize_ws(raw)
            wid = None
            for part in parts:
                if part.isdigit():
                    wid = int(part); break
            if wid is None:
                for w in self.ds.work.values():
                    if w['name'] in parts:
                        wid = w['id']; break
            if wid and wid in self.ds.work:
                work_ids.add(wid)
        char_set: Set[int] = set()
        if blk.color == 'blue':
            for wid in work_ids:
                arr = self.ds.work_chars_all_sorted.get(wid, [])
                char_set.update(arr)
            return char_set
        if not (p.roles_scope and p.role_rank_kind and p.role_rank_lo is not None and p.role_rank_hi is not None):
            return set()
        for wid in work_ids:
            arr = self.ds.work_chars_main_sorted.get(wid, []) if p.roles_scope=='main' else self.ds.work_chars_all_sorted.get(wid, [])
            if not arr: continue
            if p.role_rank_kind == 'percent':
                lo, hi = clamp_percent_to_rank(len(arr), p.role_rank_lo, p.role_rank_hi)
            else:
                lo, hi = int(p.role_rank_lo), int(p.role_rank_hi)
            chunk = rank_slice(arr, lo, hi)
            if not chunk: continue
            char_set.update(chunk)
        return char_set

    def _eval_char_list(self, blk: Block) -> Set[int]:
        p = CharListBlock(**blk.params)
        out: Set[int] = set()
        for raw in p.char_lines.splitlines():
            raw = raw.strip()
            if not raw: continue
            parts = normalize_ws(raw)
            cid = None
            for part in parts:
                if part.isdigit():
                    cid = int(part); break
            if cid is None:
                for c in self.ds.char.values():
                    if c['name'] in parts:
                        cid = c['id']; break
            if cid and cid in self.ds.char:
                out.add(cid)
        return out

    def _eval_char_range(self, blk: Block) -> Set[int]:
        p = CharRangeBlock(**blk.params)
        out: Set[int] = set()
        for cid, c in self.ds.char.items():
            if p.genders and c.get('gender') not in set(p.genders):
                continue
            ey = c.get('earliest_year'); ly = c.get('latest_year')
            if p.earliest_year:
                lo, hi = p.earliest_year
                if not (ey is not None and lo <= ey <= hi): continue
            if p.latest_year:
                lo, hi = p.latest_year
                if not (ly is not None and lo <= ly <= hi): continue
            if p.max_score:
                lo, hi = p.max_score
                s = float(c.get('max_score', 0.0))
                if not (lo <= s <= hi): continue
            if p.appear_works:
                app = self.ds.char_appear_valid.get(cid, [])
                ws = {wid for (wid, t) in app}
                if not (ws & set(p.appear_works)): continue
            if p.tag_groups:
                ok_any = False
                for g in p.tag_groups:
                    reds = [it for it in g.items if it.color == 'red']
                    blues = [it for it in g.items if it.color == 'blue']

                    # 完全空的组（没有 red / blue）忽略
                    if not reds and not blues:
                        continue

                    # 先检验红标签：若存在 red，则必须全部满足
                    if reds and not self._char_match_tagset(cid, reds, positive=True):
                        continue

                    # 再检验蓝标签：若存在 blue，则不得满足任意一个
                    if blues and not self._char_match_tagset(cid, blues, positive=False):
                        continue

                    # 这个组通过
                    ok_any = True
                    break

                if not ok_any:
                    continue

            out.add(cid)
        return out

    def _char_match_tagset(self, cid: int, items: List[TagItem], positive: bool) -> bool:
        c = self.ds.char[cid]
        app = self.ds.char_appear_valid.get(cid, [])
        app_works = [wid for (wid, t) in app]

        for it in items:
            name = it.name
            kind = it.kind
            hit = False

            if kind == "char":
                hit = name in c["char_tags"]
            elif kind == "va":
                hit = name in c["va_tags"]
            elif kind == "source":
                hit = (self.ds.char_source.get(cid) == name)
            elif kind == "work":
                # ① 角色自己的 work_tags（来自 characters_db.ndjson）
                tags_from_char = c.get("work_tags_from_char")
                if isinstance(tags_from_char, (set, list)):
                    tagset = set(tags_from_char)
                    # 若全局开关为真，则把 additional_work_tags 也纳入判定
                    if getattr(self, "include_extra_work_tags", False):
                        extra = c.get("additional_work_tags_from_char")
                        if isinstance(extra, list):
                            for item in extra:
                                if isinstance(item, dict):
                                    nm = item.get("name")
                                    if nm:
                                        tagset.add(str(nm))
                    hit = name in tagset
                else:
                    # ② 若角色上没有 work_tags_from_char，则退回到“登场作品的标签”
                    for wid in app_works:
                        w = self.ds.work.get(wid)
                        if not w:
                            continue
                        if name in w["work_tags"]:
                            hit = True
                            break

            if positive and not hit:
                return False
            if (not positive) and hit:
                return False

        return True


