from __future__ import annotations
from typing import Dict, Set, Tuple, Optional
import random
from .schemas import ConfigPayload
from .blocks import BlockEngine
from .utils import weighted_choice

class OutsetEngine:
    def __init__(self, ds):
        self.ds = ds
        self.be = BlockEngine(ds)

    def build_pool(self, cfg: ConfigPayload) -> Tuple[Dict[int,float], Dict[int, Set[int]]]:
        # 把“是否包含额外作品标签”的全局开关传给 BlockEngine
        self.be.set_include_extra_work_tags(cfg.include_extra_work_tags)

        current: Set[int] = set()
        char_weight: Dict[int, float] = {}
        for blk in cfg.blocks:
            s = self.be.eval_block(blk)
            if not s: continue
            if blk.color == 'red':
                current |= s
                for cid in s:
                    char_weight[cid] = max(char_weight.get(cid, 0.0), float(blk.weight))
            else:
                current -= s
                for cid in s:
                    if cid in char_weight: del char_weight[cid]
        work_bindings: Dict[int, Set[int]] = {}
        for cid in current:
            app = self.ds.char_appear_valid.get(cid, [])
            if not app: continue
            min_wid = None; min_year = None
            for (wid, t) in app:
                y = self.ds.work[wid]['year']
                if (min_year is None) or (y < min_year):
                    min_year = y; min_wid = wid
            if min_wid is not None:
                work_bindings.setdefault(min_wid, set()).add(cid)
        return char_weight, work_bindings

    def draw(self, cfg: ConfigPayload) -> Tuple[Optional[int], Optional[int]]:
        char_weight, work_bindings = self.build_pool(cfg)
        if not char_weight: return None, None
        rnd = random.Random(cfg.seed) if cfg.seed is not None else random.Random()
        if cfg.mode == 'char-weight':
            pairs = [(cid, w) for cid, w in char_weight.items() if w > 0]
            if not pairs: return None, None
            cid = weighted_choice(pairs, rnd)
            return cid, None
        else:
            work_pairs = []
            for wid, chars in work_bindings.items():
                maxw = 0.0
                for cid in chars:
                    maxw = max(maxw, char_weight.get(cid, 0.0))
                if maxw > 0: work_pairs.append((wid, maxw))
            if not work_pairs: return None, None
            wid = weighted_choice(work_pairs, rnd)
            cands = list(work_bindings[wid])
            if not cands: return None, None
            cid = rnd.choice(cands)
            return cid, wid
