# -*- coding: utf-8 -*-
"""单人版「猜猜呗」的容错搜索引擎（纯算法，不依赖数据库和 FastAPI）。

一个 `FuzzyIndex` 管一类对象（全部角色，或全部可见作品）。每个对象有若干个名字（显示名、原名、中文名、别名），
每个名字是索引里的一「行」(row)。查询一个字符串，返回命中的对象，按下面的档次排序：

    (完全相同 exact + 前缀 prefix，合并成一档) > 包含 (contains) > 容错 (fuzzy)

合并档里按热度（count）降序，热度相同按 id 升序，所以热门对象的前缀命中可以排在冷门对象的完全相同命中前面
（搜「露西」，热门的「露西·哈特菲利亚」在冷门的同名「露西」之前）。三条例外，细节见 _rank：
只命中别名开头的前缀排在这一档最后；完全相同的几个对象之间，原文和查询一样的在前；
最热的完全相同对象保底排进前 EXACT_FLOOR（3）个。
包含档里正式名字命中在前、别名命中在后，再按热度；容错档先按相似度分档，同一档内再按热度。
任何一个名字或别名命中都算，对象取它命中得最好的那一行。

规范化（索引和查询都做，见 normalize）：NFKC、casefold、去掉空白和各种间隔符 / 标点 / 符号、片假名折成平假名、
拉丁字母去掉附加符号（ō → o）。

容错在「读音空间」里做：每个汉字换成它的拼音音节（pypinyin，不带声调，用一个私用区字符代表），
所以同音字天然相等；字符不同但读音相同只记 0.25 的代价（HOMO_COST），别的替换 / 插入 / 删除记 1，相邻两字颠倒记 1。
查询对「名字的某一段」做带权编辑距离（Sellers 算法），超过上限的丢掉：

    汉字 / 假名：长度 1 不容错；长度 2 只认同音字（≤ 0.5）；3–4 ≤ 1；5–9 ≤ 1.5；≥ 10 ≤ 2
    拉丁字母：长度 < 4 不容错；4–7 允许 1 处错；≥ 8 允许 2 处

怎么不逐个算编辑距离（作品和角色名字加起来 60 多万行）：

- 完全相同 / 前缀 / 包含：把所有规范化后的名字用 \\x00 连成一个大字符串，用 str.find（C 实现）扫；行按对象热度降序排，
  所以按顺序扫到的前 limit 个就是热度最高的，扫够就停。
- 容错的候选：读音字符的「邻近对」(距离 1 或 2 的两个字符，不分先后) 做哈希倒排；一处错最多弄坏查询里含那个位置的几个对，
  剩下的对一定还在，所以只看查询里最稀有的 m 个对、要求候选至少命中 h 个（见 _gram_candidates），再用动态规划精确验证。
  拉丁字母用三元组倒排；4–9 个字母的短词另有「删一个字母」的邻域索引（SymSpell 思路）补上三元组管不到的短查询。
- 2 个字的同音字查询：直接在「读音大字符串」里 find。

纯拼音输入（tanzhilang）可选：切成音节后在读音大字符串里找，排在全部容错命中之后。
"""
from __future__ import annotations

import os
import re
import threading
import unicodedata
from array import array
from bisect import bisect_right
from collections import Counter
from itertools import accumulate
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

try:                                    # 没装 pypinyin 时退化成「没有同音字容错」，其余照常
    import pypinyin as _pypinyin
except Exception:  # noqa: BLE001
    _pypinyin = None

HOMO_COST = 0.25                        # 同音字替换的代价
INF = 99.0
MAX_NAME_LEN = 100                      # 规范化后超过这么长的名字不收（多半是整句说明）
MAX_TOKENS = 4                          # 多个词最多看前 4 个
MAX_QUERY = 60                          # 规范化后的查询最多看前 60 个字符（再长的不是在搜名字）
MAX_VERIFY = 600                        # 容错候选最多做这么多次动态规划
GP_CAP = 300                            # 读音大字符串里最多取这么多行
MULTI_CAP = 10000                       # 多词查询每个词最多收这么多个对象（限制常见词查询的耗时）
WORD_ROW_CAP = 300                      # 拉丁短词每个词最多取这么多行
EXACT_FLOOR = 3                         # 完全相同 + 前缀合并档里，最热的完全相同对象至少排进前这么多个
SC_ALIAS = 2.0                          # 档内排序值：只命中了别名
SC_NONLITERAL = 1.0                     # 档内排序值：完全相同，但原文（忽略大小写、全半角、空白）和查询不一样
PINYIN_MAX_LEN = 64                     # 规范化后超过这么长的串不做拼音切分
PINYIN_MAX_NODES = 5000                 # 拼音切分的递归节点数上限，超了就放弃这一路
COST_BUCKET = float(os.environ.get("SOLO_FUZZY_COST_BUCKET", "1.0"))   # 容错档：代价每这么多分一档（可用环境变量 SOLO_FUZZY_COST_BUCKET 调整）
TIER_NAMES = ("exact", "prefix", "contains", "fuzzy")


# ======================================================================== 规范化
_SPECIAL_LATIN = {"ø": "o", "đ": "d", "ł": "l", "æ": "ae", "œ": "oe", "ð": "d", "þ": "th", "ħ": "h", "ı": "i", "ŋ": "n"}


def _strip_accents(c: str) -> str:
    if c in _SPECIAL_LATIN:
        return _SPECIAL_LATIN[c]
    d = unicodedata.normalize("NFD", c)
    out = "".join(x for x in d if unicodedata.category(x) != "Mn")
    return out or c


class _NormTable(dict):
    """str.translate 用的表：键是码点，缺的第一次用到时现算现存。None = 删掉这个字符。"""

    def __missing__(self, k: int):
        c = chr(k)
        cat = unicodedata.category(c)
        if cat[0] in "ZCPS" or cat in ("Mn", "Me"):
            r = None                                              # 空白、控制符、标点、符号、组合附加符号：删
        elif 0x30A1 <= k <= 0x30F6:
            r = chr(k - 0x60)                                     # 片假名 → 平假名
        elif 0xC0 <= k <= 0x24F or 0x1E00 <= k <= 0x1EFF:
            r = _strip_accents(c)                                 # 拉丁字母去附加符号
        else:
            r = c
        self[k] = r
        return r


_NORM = _NormTable()


def normalize(s: str) -> str:
    """索引和查询共用的规范化。空白、间隔符、标点都去掉，所以返回值可能是空串。"""
    return unicodedata.normalize("NFKC", s).casefold().translate(_NORM)


def _lit(s: str) -> str:
    """「原文一样」的比较用：NFKC、忽略大小写、空白压成一个空格。"""
    return " ".join(unicodedata.normalize("NFKC", s).casefold().split())


class _WordTable(dict):
    """拉丁短词切分用：字母数字（去附加符号后）保留，其余一律变空格。"""

    def __missing__(self, k: int):
        c = chr(k)
        if 0xC0 <= k <= 0x24F or 0x1E00 <= k <= 0x1EFF:
            c = _strip_accents(c)
        r = c if (c.isascii() and c.isalnum()) else " "
        self[k] = r
        return r


_WORD = _WordTable()


def latin_words(raw: str) -> List[str]:
    return unicodedata.normalize("NFKC", raw).casefold().translate(_WORD).split()


# ======================================================================== 读音
_SYL_LOCK = threading.Lock()
SYL_CHAR: Dict[str, str] = {}           # 拼音音节 -> 私用区字符
_PUA_BASE = 0xE000


def _is_han(k: int) -> bool:
    return 0x3400 <= k <= 0x4DBF or 0x4E00 <= k <= 0x9FFF or 0xF900 <= k <= 0xFAFF or 0x20000 <= k <= 0x3134F


class _PhonTable(dict):
    """码点 -> 码点。汉字换成音节字符，其余不变。"""

    def __missing__(self, k: int):
        r = k
        if _pypinyin is not None and _is_han(k):
            try:
                res = _pypinyin.pinyin(chr(k), style=_pypinyin.Style.NORMAL, heteronym=False, errors="ignore")
            except Exception:  # noqa: BLE001
                res = []
            if res and res[0]:
                syl = res[0][0]
                with _SYL_LOCK:
                    ch = SYL_CHAR.get(syl)
                    if ch is None:
                        ch = chr(_PUA_BASE + len(SYL_CHAR))
                        SYL_CHAR[syl] = ch
                r = ord(ch)
        self[k] = r
        return r


_PHON = _PhonTable()


def phon(norm: str) -> str:
    """规范化后的字符串 -> 读音空间的字符串（长度不变）。"""
    return norm.translate(_PHON)


class _PinyinTooComplex(Exception):
    pass


def segment_pinyin(s: str, limit: int = 6) -> List[List[str]]:
    """把纯字母串切成已知拼音音节的序列（至少 2 个音节），最多返回 limit 种，音节少的在前。
    s 是规范化后的串。超过 PINYIN_MAX_LEN 个字符不切；递归超过 PINYIN_MAX_NODES 个节点（歧义太多的串，
    例如 xianxianxian…）就整个放弃，返回空列表。"""
    n = len(s)
    out: List[List[str]] = []
    if n < 3 or n > PINYIN_MAX_LEN or not SYL_CHAR:
        return out
    maxlen = max(len(x) for x in SYL_CHAR)
    nodes = 0

    def rec(i: int, acc: List[str]) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > PINYIN_MAX_NODES:
            raise _PinyinTooComplex()
        if len(out) >= 40:
            return
        if i == n:
            if len(acc) >= 2:
                out.append(list(acc))
            return
        for j in range(min(n, i + maxlen), i, -1):
            if s[i:j] in SYL_CHAR:
                acc.append(s[i:j])
                rec(j, acc)
                acc.pop()
    try:
        rec(0, [])
    except _PinyinTooComplex:
        return []
    out.sort(key=len)
    return out[:limit]


# ======================================================================== 带权编辑距离
def approx_cost(q: str, qp: str, r: str, rp: str, maxc: float) -> float:
    """q 和 r 的某一段之间的最小带权编辑距离（Sellers：r 两头可以不要）。qp / rp 是它们的读音空间形式。
    代价：相同 0；同音不同字 0.25；其他替换 / 插入 / 删除 1；相邻两个字颠倒 1。超过 maxc 返回 INF。"""
    L, m = len(q), len(r)
    if L == 0 or m == 0:
        return INF
    prev = [0.0] * (m + 1)
    prev2: Optional[List[float]] = None
    for i in range(1, L + 1):
        qc = q[i - 1]
        pc = qp[i - 1]
        pc_prev = qp[i - 2] if i > 1 else ""
        cur = [float(i)] * (m + 1)
        left = cur[0]
        lo = left
        for j in range(1, m + 1):
            if qc == r[j - 1]:
                d = prev[j - 1]
            elif pc == rp[j - 1]:
                d = prev[j - 1] + HOMO_COST
            else:
                d = prev[j - 1] + 1.0
            t = prev[j] + 1.0
            if t < d:
                d = t
            t = left + 1.0
            if t < d:
                d = t
            if prev2 is not None and j > 1 and pc == rp[j - 2] and pc_prev == rp[j - 1]:
                t = prev2[j - 2] + 1.0
                if t < d:
                    d = t
            cur[j] = d
            left = d
            if d < lo:
                lo = d
        if lo > maxc:
            return INF
        prev2, prev = prev, cur
    best = min(prev)
    return best if best <= maxc else INF


def within1(a: str, b: str) -> bool:
    """Damerau-Levenshtein 距离 ≤ 1（替换 / 插入 / 删除 / 相邻两字颠倒）。"""
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        if a == b:
            return True
        i = 0
        while a[i] == b[i]:
            i += 1
        if a[i + 1:] == b[i + 1:]:
            return True
        return i + 1 < la and a[i] == b[i + 1] and a[i + 1] == b[i] and a[i + 2:] == b[i + 2:]
    if la > lb:
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


def max_cost(L: int, latin: bool) -> float:
    """长度为 L 的查询能容忍的最大代价。"""
    if latin:
        if L < 4:
            return -1.0
        return 1.0 if L < 8 else 2.0
    if L < 2:
        return -1.0
    if L == 2:
        return 0.5
    if L <= 4:
        return 1.0
    if L <= 9:
        return 1.5
    return 2.0


# ======================================================================== 哈希
_LATIN_CODE = {c: i for i, c in enumerate("0123456789abcdefghijklmnopqrstuvwxyz")}


def _pair_key(a: int, b: int, mask: int) -> int:
    k = ((a + b) * 2654435761) ^ (a * b * 40503)
    return (k ^ (k >> 15)) & mask


def _pow2_at_least(n: int, lo: int = 1 << 16) -> int:
    p = lo
    while p < n:
        p <<= 1
    return p


def _offsets(parts: Sequence[str]) -> "array[int]":
    """\\x00 连接的大字符串里每一段第一个字符的位置（第 0 段从 1 开始）；最后一项 = 大字符串的长度。"""
    return array("I", accumulate((len(x) + 1 for x in parts), initial=1))


class _CSR:
    """键 -> 行号列表 的紧凑倒排（偏移数组 + 数据数组）。"""
    __slots__ = ("off", "post")

    def __init__(self, nbuckets: int, keys: "array[int]", rows: "array[int]"):
        cnt = array("I", bytes(4 * (nbuckets + 1)))
        for k in keys:
            cnt[k + 1] += 1
        self.off = array("I", accumulate(cnt))
        pos = array("I", self.off)
        post = array("I", bytes(4 * len(keys)))
        for k, r in zip(keys, rows):
            p = pos[k]
            post[p] = r
            pos[k] = p + 1
        self.post = post

    def get(self, k: int):
        return self.post[self.off[k]:self.off[k + 1]]

    def size(self, k: int) -> int:
        return self.off[k + 1] - self.off[k]


# ======================================================================== 索引
Hit = Tuple[int, float, int, int]       # (档次 0-3, 档内排序值, 对象序号, 行号)


class FuzzyIndex:
    """entities：[(id, count, [名字…], n_primary?)]，必须已经按 (count 降序, id 升序) 排好（对象序号 = 热度排名）。
    名字列表里前 n_primary 个是正式名字（库里的 display_name / name / name_cn），其余是别名；不给 n_primary 就都算正式名字。
    同一档里正式名字命中的排在别名命中前面（这样搜某个角色的原名时，别的角色把它当别名也不会抢到前面）。"""

    def __init__(self, entities: Sequence[Tuple]):
        self.ent_ids = array("q")
        self.ent_counts = array("q")
        self.row_ent = array("I")
        self.row_alias = bytearray()
        norms: List[str] = []
        raws_kept: List[str] = []
        for ei, ent in enumerate(entities):
            eid, cnt, raws = ent[0], ent[1], ent[2]
            n_primary = ent[3] if len(ent) > 3 else len(raws)
            self.ent_ids.append(eid)
            self.ent_counts.append(cnt)
            seen: Set[str] = set()
            for k, raw in enumerate(raws):
                if not raw:
                    continue
                nm = normalize(raw)
                if not nm or len(nm) > MAX_NAME_LEN or nm in seen:
                    continue
                seen.add(nm)
                norms.append(nm)
                raws_kept.append(raw)
                self.row_ent.append(ei)
                self.row_alias.append(1 if k >= n_primary else 0)
        self.n_rows = len(norms)
        # 大字符串：\x00 名字 \x00 名字 \x00 …；off[r] = 第 r 行第一个字符的位置，off[n] = len(G)
        self.G = "\x00" + "\x00".join(norms) + "\x00"
        self.off = _offsets(norms)
        # 原文（没规范化的）给 matched 用，也连成一个大字符串，不留 60 万个小字符串对象
        self.RAW = "\x00" + "\x00".join(r.replace("\x00", " ") for r in raws_kept) + "\x00"
        self.raw_off = _offsets(raws_kept)
        self._build_phonetic(norms)
        self._build_latin(norms, raws_kept)

    # ---------------------------------------------------------------- 建索引
    def _build_phonetic(self, norms: List[str]) -> None:
        """读音大字符串（只含有汉字的行）+ 非拉丁行的邻近对倒排。"""
        n = len(norms)
        latin = [x.isascii() and x.isalnum() for x in norms]
        self.latin_row = bytearray(latin)
        gp_parts: List[str] = []
        gp_rows = array("I")
        keys = array("I")
        krows = array("I")
        # 预估桶数：每行约 (2m-3) 个键
        total_chars = sum(len(x) for x, lt in zip(norms, latin) if not lt)
        self.pair_mask = _pow2_at_least(total_chars * 2, 1 << 18) - 1
        mask = self.pair_mask
        for r, nm in enumerate(norms):
            if latin[r]:
                continue
            p = phon(nm)
            if p != nm:
                gp_parts.append(p)
                gp_rows.append(r)
            if len(p) < 2:
                continue
            o = list(map(ord, p))
            ks = {((a + b) * 2654435761 ^ a * b * 40503) for a, b in zip(o, o[1:])}
            ks.update(((a + b) * 2654435761 ^ a * b * 40503) for a, b in zip(o, o[2:]))
            ks = {(k ^ (k >> 15)) & mask for k in ks}
            keys.extend(ks)
            krows.extend(array("I", [r]) * len(ks))
        self.GP = "\x00" + "\x00".join(gp_parts) + "\x00"
        self.gp_off = _offsets(gp_parts)
        self.gp_rows = gp_rows
        self.pair = _CSR(mask + 1, keys, krows)
        del keys, krows

    def _build_latin(self, norms: List[str], raws: List[str]) -> None:
        """纯拉丁行的三元组倒排；所有行里拉丁短词的「删一个字母」邻域索引。"""
        code = _LATIN_CODE
        keys = array("I")
        krows = array("I")
        for r, nm in enumerate(norms):
            if not self.latin_row[r] or len(nm) < 3:
                continue
            c = [code[ch] for ch in nm]
            ks = {a * 1296 + b * 36 + d for a, b, d in zip(c, c[1:], c[2:])}
            keys.extend(ks)
            krows.extend(array("I", [r]) * len(ks))
        self.tri = _CSR(36 ** 3, keys, krows)
        del keys, krows
        # 词表：所有行的原文里切出来的拉丁字母数字词（长度 3–9）
        vocab: Dict[str, int] = {}
        vlist: List[str] = []
        wkeys = array("I")
        wrows = array("I")
        latin_row = self.latin_row
        for r, raw in enumerate(raws):
            if raw.isascii() and not any(ch.isalpha() for ch in raw):
                continue
            seen: Set[int] = set()
            ws = latin_words(raw)
            if latin_row[r] and len(ws) > 1 and 4 <= len(norms[r]) <= 9:
                ws.append(norms[r])              # 整个名字连起来也当一个词（查询里的空格会被去掉）
            for w in ws:
                if not 3 <= len(w) <= 9:
                    continue
                wid = vocab.get(w)
                if wid is None:
                    wid = len(vlist)
                    vocab[w] = wid
                    vlist.append(w)
                if wid not in seen:
                    seen.add(wid)
                    wkeys.append(wid)
                    wrows.append(r)
        self.vocab = vlist
        self.word_rows = _CSR(max(1, len(vlist)), wkeys, wrows)
        del wkeys, wrows
        self.var_mask = _pow2_at_least(len(vlist) * 6, 1 << 16) - 1
        vkeys = array("I")
        vwids = array("I")
        mask = self.var_mask
        for wid, w in enumerate(vlist):
            hs = {hash(w) & mask}
            hs.update(hash(w[:i] + w[i + 1:]) & mask for i in range(len(w)))
            vkeys.extend(hs)
            vwids.extend(array("I", [wid]) * len(hs))
        self.word_var = _CSR(mask + 1, vkeys, vwids)
        del vkeys, vwids

    # ---------------------------------------------------------------- 取行
    def row_norm(self, r: int) -> str:
        return self.G[self.off[r]:self.off[r + 1] - 1]

    def row_raw(self, r: int) -> str:
        return self.RAW[self.raw_off[r]:self.raw_off[r + 1] - 1]

    # ---------------------------------------------------------------- 查询入口
    def search(self, raw: str, limit: int) -> List[Hit]:
        """返回最多 limit 个命中，已排好序：(档次, 档内排序值, 对象序号, 命中的行号)。档次 0 = exact、1 = prefix，
        但这两档在排序时合并成一档（见 _rank），所以返回的顺序里 prefix 可能排在 exact 前面。"""
        all_toks = [t[:MAX_QUERY] for t in (normalize(x) for x in raw[:4 * MAX_QUERY].split()) if t]
        q = "".join(all_toks)[:MAX_QUERY]                   # 完全相同 / 前缀 / 包含 / 容错：用整个查询（最多 60 个字符）
        toks = all_toks[:MAX_TOKENS]                        # 「任意顺序」的多词匹配只看前 4 个词（防止太慢）
        if not q or limit <= 0:
            return []
        found: Dict[int, Tuple[int, float, int]] = {}
        self._scan_tiers(q, limit, found, _lit(raw))
        if len(toks) >= 2 and len(found) < limit:
            self._scan_multi(toks, limit, found)
        if len(found) < limit:
            self._fuzzy(q, limit - len(found), found)
        return self._rank(found)[:limit]

    @staticmethod
    def _rank(found: Dict[int, Tuple[int, float, int]]) -> List[Hit]:
        """排序：(完全相同 + 前缀，合并成一档) > 包含 > 容错。
        - 合并档按热度排（对象序号 = 热度排名）。这样打「露西」时，热门的「露西·哈特菲利亚」（前缀）排在冷门的同名「露西」（完全相同）前面。
          例外一：只命中了别名的开头（别名前缀）的，排在这一档其余命中之后（别名前缀太容易撞上，比如搜 Roc 撞 Rock Lee）。
          例外二：完全相同的几个对象之间，原文和查询一样的在前（搜「银魂'」时，「银魂'」排在更热的「银魂」前面），再按热度。
          这一档里最热的那个完全相同的对象保底排进前 EXACT_FLOOR 个，它本来就在前面就不动。
        - 包含档：正式名字命中在前、别名命中在后，再按热度；容错档：按相似度分档，再按热度（score 由 _fuzzy 算好）。"""
        front: List[Hit] = []
        rest: List[Hit] = []
        for e, (t, s, r) in found.items():
            (front if t <= 1 else rest).append((t, s, e, r))
        rest.sort(key=lambda h: (h[0], h[1], h[2]))
        front.sort(key=lambda h: (1 if (h[0] == 1 and h[1] >= SC_ALIAS) else 0, h[2]))
        slots = [i for i, h in enumerate(front) if h[0] == 0]               # 完全相同的对象占着的位置（已按热度排）
        if not slots:
            return front + rest
        if len(slots) > 1:                                                  # 这些位置不动，里面的对象按「原文一样的在前」重排
            ordered = sorted((front[i] for i in slots), key=lambda h: (int(h[1]) & 1, h[2]))
            for i, h in zip(slots, ordered):
                front[i] = h
        hot = min(slots, key=lambda i: front[i][2])                         # 最热的完全相同对象现在的位置
        if hot >= EXACT_FLOOR:
            front.insert(EXACT_FLOOR - 1, front.pop(hot))
        return front + rest

    # ---------------------------------------------------------------- 完全相同 / 前缀 / 包含
    def _scan_tiers(self, q: str, limit: int, found: Dict[int, Tuple[int, float, int]], lit: str = "") -> None:
        """三档各扫一遍：行按热度排好，所以扫到的前 cap 个对象就是这一档里最热的。
        sc = 别名命中 SC_ALIAS + 完全相同档里原文和查询不一样 SC_NONLITERAL（怎么用见 _rank）。
        每个对象记下命中得最好的那一行（正式名字优先，给 matched 用）。"""
        G, off, row_ent, row_alias = self.G, self.off, self.row_ent, self.row_alias
        cap = max(limit * 4, 100)
        for tier, needle, lead in ((0, "\x00" + q + "\x00", 1), (1, "\x00" + q, 1), (2, q, 0)):
            local: Dict[int, Tuple[int, int]] = {}                  # 对象 -> (是别名命中, 行)
            pos = G.find(needle)
            while pos >= 0 and len(local) < cap:
                r = bisect_right(off, pos + lead) - 1
                e = row_ent[r]
                if e not in found:
                    cur = local.get(e)
                    if cur is None or (cur[0] and not row_alias[r]):
                        local[e] = (row_alias[r], r)
                pos = G.find(needle, off[r + 1] - lead)
            for e, (al, r) in local.items():
                sc = SC_ALIAS if al else 0.0
                if tier == 0 and lit and _lit(self.row_raw(r)) != lit:
                    sc += SC_NONLITERAL
                found[e] = (tier, sc, r)

    def _collect_contains(self, t: str, cap: int) -> Dict[int, int]:
        """名字里包含 t 的对象 -> 第一个命中的行。"""
        G, off, row_ent = self.G, self.off, self.row_ent
        out: Dict[int, int] = {}
        pos = G.find(t)
        while pos >= 0 and len(out) < cap:
            r = bisect_right(off, pos) - 1
            e = row_ent[r]
            if e not in out:
                out[e] = r
            pos = G.find(t, off[r + 1])
        return out

    def _scan_multi(self, toks: List[str], limit: int, found: Dict[int, Tuple[int, float, int]]) -> None:
        """多个词任意顺序：每个词都出现在同一个对象的名字里（可以在不同的名字里）。算「包含」，排在连续包含之后。"""
        sets = [self._collect_contains(t, MULTI_CAP) for t in toks]
        sets.sort(key=len)
        first = sets[0]
        got = 0
        for e in sorted(first):
            if e in found:
                continue
            if all(e in s for s in sets[1:]):
                found[e] = (2, 3.0, first[e])
                got += 1
                if got >= limit:
                    break

    # ---------------------------------------------------------------- 容错
    def _fuzzy(self, q: str, need: int, found: Dict[int, Tuple[int, float, int]]) -> None:
        L = len(q)
        latin = q.isascii() and q.isalnum()
        maxc = max_cost(L, latin)
        cand: Dict[int, int] = {}
        pinyin_rows: Dict[int, int] = {}
        if latin:
            if maxc >= 0:
                self._latin_candidates(q, L, maxc, cand)
            if q.isalpha() and L >= 4:
                self._pinyin_candidates(q, pinyin_rows)
            qp = q
        else:
            if maxc < 0:
                return
            qp = phon(q)
            self._nonlatin_candidates(q, qp, L, maxc, cand)
        best: Dict[int, Tuple[float, int]] = {}         # 对象 -> (排序分, 行)
        row_ent = self.row_ent
        if cand:
            order = sorted(cand.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_VERIFY]
            qset = set(qp)
            e_chars = 0 if maxc < 1 else (1 if maxc < 2 else 2)
            if not latin and L <= 2:
                e_chars = 0
            need_common = max(1, L - e_chars)
            for r, _h in order:
                e = row_ent[r]
                if e in found:
                    continue
                nm = self.row_norm(r)
                rp = phon(nm) if not latin else nm
                if len(qset) > 1 and sum(1 for c in qset if c in rp) < min(need_common, len(qset)) and not latin:
                    continue
                c = approx_cost(q, qp, nm, rp, maxc)
                if c >= INF:
                    continue
                ratio = L / len(nm)
                # 排序：先看有没有「真错误」（只有同音字替换的 < 1 算同一档，一处真错误 1.x 一档，两处 2.x 一档），
                # 再看查询占整个名字的比例（越接近整个名字越靠前），同档内按热度
                score = int(c / COST_BUCKET) * 3 + (0 if ratio >= 0.6 else (1 if ratio >= 0.35 else 2))
                cur = best.get(e)
                if cur is None or score < cur[0]:
                    best[e] = (score, r)
        for r, _h in pinyin_rows.items():
            e = row_ent[r]
            if e in found or e in best:
                continue
            best[e] = (99, r)
        if not best:
            return
        ranked = sorted(best.items(), key=lambda kv: (kv[1][0], kv[0]))[:need]
        for e, (score, r) in ranked:
            found[e] = (3, float(score), r)

    # ---- 候选：汉字 / 假名
    def _nonlatin_candidates(self, q: str, qp: str, L: int, maxc: float, cand: Dict[int, int]) -> None:
        if qp != q and self.GP:                     # 有汉字：读音大字符串里直接找
            GP, off, rows = self.GP, self.gp_off, self.gp_rows
            pos = GP.find(qp)
            got = 0
            while pos >= 0 and got < GP_CAP:
                i = bisect_right(off, pos) - 1
                cand[rows[i]] = 99
                got += 1
                pos = GP.find(qp, off[i + 1])
        if L >= 3:
            e = 1 if maxc < 2 else 2
            o = [ord(c) for c in qp]
            mask = self.pair_mask
            kpos: Dict[int, Set[int]] = {}
            for i in range(L - 1):
                kpos.setdefault(_pair_key(o[i], o[i + 1], mask), set()).update((i, i + 1))
            for i in range(L - 2):
                kpos.setdefault(_pair_key(o[i], o[i + 2], mask), set()).update((i, i + 2))
            for r, h in self._gram_candidates(kpos, L, e, self.pair).items():
                if cand.get(r, 0) < h:
                    cand[r] = h

    # ---- 候选：拉丁字母
    def _latin_candidates(self, q: str, L: int, maxc: float, cand: Dict[int, int]) -> None:
        if 4 <= L <= 9:
            mask = self.var_mask
            wids: Set[int] = set()
            for v in {q} | {q[:i] + q[i + 1:] for i in range(L)}:
                wids.update(self.word_var.get(hash(v) & mask))
            vocab = self.vocab
            for wid in wids:
                if within1(q, vocab[wid]):
                    for r in self.word_rows.get(wid)[:WORD_ROW_CAP]:
                        if cand.get(r, 0) < 50:
                            cand[r] = 50
        if L >= 6:
            e = 1 if maxc < 2 else 2
            code = _LATIN_CODE
            c = [code[ch] for ch in q]
            kpos: Dict[int, Set[int]] = {}
            for i in range(L - 2):
                kpos.setdefault(c[i] * 1296 + c[i + 1] * 36 + c[i + 2], set()).update((i, i + 1, i + 2))
            for r, h in self._gram_candidates(kpos, L, e, self.tri, span=2).items():
                if cand.get(r, 0) < h:
                    cand[r] = h

    # ---- 候选：纯拼音输入
    def _pinyin_candidates(self, q: str, out: Dict[int, int]) -> None:
        if not self.GP:
            return
        GP, off, rows = self.GP, self.gp_off, self.gp_rows
        for seg in segment_pinyin(q):
            ps = "".join(SYL_CHAR[s] for s in seg)
            pos = GP.find(ps)
            got = 0
            while pos >= 0 and got < 100:
                i = bisect_right(off, pos) - 1
                out.setdefault(rows[i], 1)
                got += 1
                pos = GP.find(ps, off[i + 1])

    # ---- 邻近对 / 三元组的计数过滤
    @staticmethod
    def _gram_candidates(kpos: Dict[int, Set[int]], L: int, e: int, csr: _CSR, span: int = 1) -> Dict[int, int]:
        """kpos：查询里每个不同的键 -> 它涉及的查询位置。至多 e 处硬错误，每处弄坏所有涉及某 span 个相邻位置的键
        （span=1：替换 / 增删；span=2：相邻两字颠倒也算一处），所以真正的命中至少共有 τ = n − d 个键
        （d = 弄坏最多的 e 处的键数之和）。只看最稀有的 m 个非空键，要求候选至少命中 h 个：
        m = n' − τ + h，h = min(τ, 3) 时由抽屉原理保证不漏。"""
        keys = [k for k in kpos if csr.size(k) > 0]
        n = len(kpos)
        inv = []
        for p in range(max(1, L - span + 1)):
            lo, hi = p, p + span
            inv.append(sum(1 for ps in kpos.values() if any(lo <= x < hi for x in ps)))
        d = sum(sorted(inv, reverse=True)[:e])
        tau = max(1, n - d)
        if tau > len(keys):
            return {}
        h = min(tau, 3)
        m = min(len(keys), len(keys) - tau + h)
        keys.sort(key=csr.size)
        cnt: Counter = Counter()
        for k in keys[:m]:
            cnt.update(csr.get(k))
        return {r: c for r, c in cnt.items() if c >= h}
