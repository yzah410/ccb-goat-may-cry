from __future__ import annotations
import re, math
from typing import List, Optional, Tuple

YEAR_RE = re.compile(r"(?<!\d)(19\d{2}|20\d{2})(?!\d)")

# 解析 infobox 指定键后的年份（优先级：放送开始 > 上映年度 > 发售日）
INFOBOX_KEYS = ["放送开始", "上映年度", "发售日"]
KEY_RE = re.compile(r"^\|\s*([^=|]+?)\s*=\s*(.+?)\s*$", re.M)


def parse_infobox_year(infobox: Optional[str]) -> Optional[int]:
    if not infobox:
        return None
    try:
        kv = {}
        for m in KEY_RE.finditer(infobox):
            k = m.group(1).strip()
            v = m.group(2).strip()
            kv[k] = v
        for key in INFOBOX_KEYS:
            if key in kv:
                y = first_year(kv[key])
                if y:
                    return y
    except Exception:
        pass
    return None


def first_year(text: str) -> Optional[int]:
    m = YEAR_RE.search(text or "")
    if m:
        return int(m.group(1))
    return None


def normalize_ws(line: str) -> List[str]:
    import re as _re
    return _re.split(r"[\s　]+", line.strip())


def clamp_percent_to_rank(n_items: int, lo_pct: float, hi_pct: float) -> Tuple[int,int]:
    hi = int(math.ceil(n_items * (hi_pct/100.0)))
    lo = int(math.floor(n_items * (lo_pct/100.0)))
    lo = max(1, lo)
    hi = max(1, hi)
    lo = min(lo, n_items)
    hi = min(hi, n_items)
    if lo > hi:
        lo, hi = hi, lo
    return lo, hi


def rank_slice(sorted_ids: List[int], lo_rank: int, hi_rank: int) -> List[int]:
    lo = max(1, lo_rank)
    hi = max(1, hi_rank)
    if lo > hi:
        lo, hi = hi, lo
    lo_idx = lo - 1
    hi_idx = hi - 1
    lo_idx = max(0, lo_idx)
    hi_idx = min(len(sorted_ids)-1, hi_idx)
    return sorted_ids[lo_idx:hi_idx+1]


def weighted_choice(pairs: List[Tuple[int, float]], rnd) -> Optional[int]:
    total = sum(w for _, w in pairs)
    if total <= 0:
        return None
    x = rnd.random() * total
    acc = 0.0
    for _id, w in pairs:
        acc += w
        if x <= acc:
            return _id
    return pairs[-1][0]
