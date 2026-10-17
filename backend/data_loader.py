from __future__ import annotations
import os, json
from typing import Dict, Any, List, Tuple, Set, Optional
from .utils import parse_infobox_year, first_year

# 来源标签只认这四类
SOURCE_CANON = {"原创", "漫画改", "小说改", "游戏改"}


def _as_float(x) -> float:
    try:
        return float(x)
    except Exception:
        return 0.0


def _require(path: Optional[str], label: str) -> str:
    """必需的数据文件缺失时抛出带安装提示的报错。"""
    if not path or not os.path.exists(path):
        raise RuntimeError(
            f"经典工作台数据缺少文件 [{label}]：{path}\n"
            f"→ 把数据包里的经典工作台数据解压到 data/classic/（见 docs/legacy.md 的「经典工作台」一节）。"
        )
    return path


class DataStore:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.loaded = False
        # 基础表
        self.char: Dict[int, Dict[str, Any]] = {}
        self.work: Dict[int, Dict[str, Any]] = {}
        # 索引
        self.work_year_sorted: Dict[int, List[int]] = {}
        self.merged_sorted: List[int] = []
        self.work_by_tag: Dict[str, Set[int]] = {}
        self.char_appear_valid: Dict[int, List[Tuple[int, int]]] = {}
        self.work_chars_main_sorted: Dict[int, List[int]] = {}
        self.work_chars_all_sorted: Dict[int, List[int]] = {}
        self.char_source: Dict[int, str] = {}

    def load(self):
        if self.loaded:
            return
        dp = self.cfg["data_paths"]

        # ---------- 1) 加载角色数据库 ----------
        # max_score 优先读 highest_rating，其次 rating / score / max_score
        with open(_require(dp.get("characters_db"), "characters_db"), "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                o = json.loads(line)
                cid = int(o["id"]) if not isinstance(o["id"], int) else o["id"]

                # 基础字段：供 block 过滤 / 权重计算使用
                base = {
                    "id": cid,
                    "name": o.get("name_cn") or o.get("name") or str(cid),
                    "gender": o.get("gender", "?"),           # "?"/"♂"/"♀"
                    "heat": int(o.get("heat", 0)),
                    "max_score": _as_float(
                        o.get(
                            "highest_rating",
                            o.get("rating", o.get("score", o.get("max_score", 0.0))),
                        )
                    ),
                    "char_tags": set(o.get("character_tags", [])),
                    "va_tags": set(o.get("va_tags", [])),
                }

                # ---- characters_db 里的登场统计、标签、来源、登场年份 ----
                # 登场统计、来源、登场年份只用于展示和统计；
                # work_tags / additional_work_tags 也参与作品标签筛选（见 blocks.py）。

                # 1) 登场统计
                if "work_count" in o:
                    try:
                        base["work_count_from_char"] = int(o.get("work_count") or 0)
                    except Exception:
                        base["work_count_from_char"] = None

                if "appearances" in o:
                    # appearances: ["租借女友", "……"] 直接透传为字符串列表
                    app_list = o.get("appearances") or []
                    if isinstance(app_list, list):
                        base["appearances_from_char"] = [str(x) for x in app_list]

                # 2) 作品标签 / 追加标签
                if "work_tags" in o:
                    wt = o.get("work_tags") or []
                    if isinstance(wt, list):
                        base["work_tags_from_char"] = [str(x) for x in wt]

                if "additional_work_tags" in o:
                    awt = o.get("additional_work_tags") or []
                    # 原样存下（[{name, rank}, ...]）；开启「包含额外作品标签」时并入作品标签
                    if isinstance(awt, list):
                        base["additional_work_tags_from_char"] = awt

                # 3) 来源标签
                if "source_tags" in o:
                    # 单个字符串："小说改" / "漫画改" ...
                    base["source_tag_from_char"] = o.get("source_tags")

                # 4) characters_db 里的最早/最晚登场年（用于展示和统计；筛选用的是下面按登场表算出的 earliest_year / latest_year）
                if "earliest_appearance" in o:
                    try:
                        base["earliest_year_from_char"] = int(o.get("earliest_appearance"))
                    except Exception:
                        pass
                if "latest_appearance" in o:
                    try:
                        base["latest_year_from_char"] = int(o.get("latest_appearance"))
                    except Exception:
                        pass

                self.char[cid] = base

        # ---------- 2) 作品和角色出演表 ----------
        subj_path = _require(dp.get("subject"), "subject.jsonlines")
        subj_chars_path = _require(dp.get("subject_characters"), "subject-characters.jsonlines")

        # ---------- 3) 加载作品 ----------
        raw_work: Dict[int, Dict[str, Any]] = {}
        with open(subj_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                s = json.loads(line)
                if int(s.get("type", 0)) != 2:
                    continue  # 仅动画
                wid = int(s["id"])
                if bool(s.get("nsfw", False)):
                    continue  # 排除 NSFW
                tags = [
                    x.get("name") if isinstance(x, dict) else str(x)
                    for x in s.get("tags", [])
                ]
                meta_tags = s.get("meta_tags", [])
                fav = s.get("favorite", {})
                favorites_total = int(
                    sum(int(fav.get(k, 0)) for k in ["wish", "done", "doing", "on_hold", "dropped"])
                )
                # 年份：优先用作品表里的 year；没有时按 infobox 算：
                # ["放送开始"] > ["上映年度"] > ["发售日"]；再没有就取 tags/meta_tags 中的年份
                year = s.get("year") or parse_infobox_year(s.get("infobox"))
                if not year:
                    year = first_year(" ".join(tags) + " " + " ".join(meta_tags))
                if not year:
                    continue  # 无法确定年份则不纳入
                raw_work[wid] = {
                    "id": wid,
                    "name": s.get("name_cn") or s.get("name") or str(wid),
                    "favorites": favorites_total,
                    "year": int(year),
                    "tags": set(tags),
                    "meta_tags": set(meta_tags),
                    "score": _as_float(s.get("score", 0.0)),
                }

        # ---------- 4) 从 work-tags.valid.ndjson 载入作品标签 ----------
        work_tags_valid: Dict[int, List[str]] = {}
        wt_path = dp.get("work_tags_valid")
        if wt_path and os.path.exists(wt_path):
            with open(wt_path, "r", encoding="utf-8") as f2:
                for line in f2:
                    line = line.strip()
                    if not line:
                        continue
                    o = json.loads(line)
                    try:
                        wid = int(o.get("id") or 0)
                    except Exception:
                        continue
                    if wid <= 0:
                        continue
                    # 只保留动画（type == 2），和 raw_work 一致
                    tp = int(o.get("type") or 0)
                    if tp != 2:
                        continue
                    tags = o.get("tags") or []
                    if isinstance(tags, list):
                        work_tags_valid[wid] = [str(t) for t in tags]
        # 没有这个文件时 work_tags_valid 是空 dict，下面每部作品都用作品表里的标签名

        # ---------- 5) 构建最终作品表、倒排索引、年份索引 ----------
        for wid, w in raw_work.items():
            # 作品标签：优先用 work-tags.valid.ndjson 中的 tags
            vt = work_tags_valid.get(wid)
            if vt is not None:
                work_tags = set(str(t) for t in vt)
            else:
                # valid 文件里没有这部作品：用作品表里的标签名（tags 和 meta_tags）
                work_tags = set(w["meta_tags"]) | set(w["tags"])

            self.work[wid] = {
                "id": wid,
                "name": w["name"],
                "year": w["year"],
                "score": w["score"],
                "favorites": w["favorites"],
                "work_tags": work_tags,
            }
            # 倒排：tag -> works
            for t in work_tags:
                self.work_by_tag.setdefault(t, set()).add(wid)
            # 年份：每年按 favorites 降序
            self.work_year_sorted.setdefault(w["year"], []).append(wid)
        for y, arr in self.work_year_sorted.items():
            arr.sort(key=lambda wid: self.work[wid]["favorites"], reverse=True)

        # ---------- 6) 角色登场关系（仅 type:1 主角、type:2 配角；与动画/非 NSFW 对齐） ----------
        appear_by_work: Dict[int, List[Tuple[int, int]]] = {}
        with open(subj_chars_path, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                sc = json.loads(line)
                tp = int(sc.get("type", 0))
                if tp not in (1, 2):
                    continue
                wid = int(sc.get("subject_id") or sc.get("work_id") or 0)
                cid = int(sc.get("character_id") or sc.get("char_id") or 0)
                if wid not in self.work:
                    continue
                if cid not in self.char:
                    continue
                appear_by_work.setdefault(wid, []).append((cid, tp))
                self.char_appear_valid.setdefault(cid, []).append((wid, tp))

        # 各作品下角色（主角 / 含配角）按 heat 降序
        for wid, plist in appear_by_work.items():
            mains = [cid for (cid, t) in plist if t == 1]
            alls = [cid for (cid, t) in plist if t in (1, 2)]
            mains.sort(key=lambda cid: self.char[cid]["heat"], reverse=True)
            alls.sort(key=lambda cid: self.char[cid]["heat"], reverse=True)
            self.work_chars_main_sorted[wid] = mains
            self.work_chars_all_sorted[wid] = alls

        # 角色的最早/最晚登场年
        for cid, plist in self.char_appear_valid.items():
            years = [self.work[wid]["year"] for (wid, _) in plist if wid in self.work]
            if years:
                self.char[cid]["earliest_year"] = min(years)
                self.char[cid]["latest_year"] = max(years)
            else:
                self.char[cid]["earliest_year"] = None
                self.char[cid]["latest_year"] = None

        # ---------- 7) 角色唯一来源（作品标签映射），list / dict 两种格式都认 ----------
        # 可选：来源筛选（blocks.py 的 kind=="source"）和来源标签补全只认这份映射；
        # 展示和统计时，角色行自带的 source_tags 优先，没有才用它。缺失时映射为空，不影响启动。
        srcmap: Any = []
        scp = dp.get("character_source_counts")
        if scp and os.path.exists(scp):
            with open(scp, "r", encoding="utf-8") as f:
                srcmap = json.load(f)
        else:
            print(
                f"[data_loader] 可选数据缺失，来源筛选没有数据 [character_source_counts]：{scp}",
                flush=True,
            )

        # 支持两种形态：
        #   A) {"183664":"小说改", ...}
        #   B) [{"character_id":183664, "top":"小说改", ...}, ...]
        items: List[Tuple[int, str]] = []
        if isinstance(srcmap, dict):
            for k, v in srcmap.items():
                try:
                    items.append((int(k), str(v)))
                except Exception:
                    continue
        elif isinstance(srcmap, list):
            for item in srcmap:
                if not isinstance(item, dict):
                    continue
                cid = item.get("character_id") or item.get("id")
                v = item.get("top") or item.get("source") or item.get("value")
                if cid is None or v is None:
                    continue
                try:
                    items.append((int(cid), str(v)))
                except Exception:
                    continue
        else:
            raise TypeError(f"character_source_counts.json 的格式不对：应为对象或列表，实际是 {type(srcmap).__name__}")

        for cid, v in items:
            if cid in self.char and v in SOURCE_CANON:
                self.char_source[cid] = v

        self.loaded = True

    # ---------- 工具方法 ----------
    def works_in_years(self, y_min: int, y_max: int) -> List[int]:
        out = []
        for y in range(y_min, y_max + 1):
            out.extend(self.work_year_sorted.get(y, []))
        return out

    def works_by_tag_groups(
        self, base: Set[int], tag_groups: List[List[Tuple[str, str]]]
    ) -> Set[int]:
        """
        tag_groups: [ [(tag,'red'|'blue'), ...], ... ] —— 仅 work 标签

        逻辑：
          - 对于每个小组块 grp：
              reds: 必须同时包含的作品标签（AND）
              blues: 不得包含的作品标签（NOT）
            条件是：
              · 若 reds 非空：作品必须含有 grp 中所有 red 标签；
              · 若 blues 非空：作品不能含有 grp 中任一 blue 标签；
            组块之间是 OR：满足任意一个组块即可。

          - 允许“仅蓝组”（reds 为空、blues 非空）：
              等价于“在 base 中排除掉含任一该组蓝标签的作品”。
        """
        if not tag_groups:
            return set(base)
        result: Set[int] = set()
        for grp in tag_groups:
            reds = [t for (t, c) in grp if c == "red"]
            blues = [t for (t, c) in grp if c == "blue"]

            # 完全空的组（既没 red 也没 blue）直接忽略
            if not reds and not blues:
                continue

            # 满足“包含全部 red”
            if reds:
                sets = [self.work_by_tag.get(r, set()) for r in reds]
                if not sets:
                    continue
                cand = set.intersection(*sets)
            else:
                # 无 red：从 base 开始，只做“排除蓝标签”
                cand = set(base)

            # 排除“含任一 blue”
            if blues:
                blue_set = set()
                for b in blues:
                    blue_set |= self.work_by_tag.get(b, set())
                cand -= blue_set

            result |= (cand & base)
        return result
