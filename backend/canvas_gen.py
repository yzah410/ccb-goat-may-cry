import re
import unicodedata
import uuid

# ==================== 配置常量 ====================
GAP_X = 40        # 极短的水平间距
GAP_Y = 20        # 垂直间距

# 配色：根节点用 ROOT_COLOR，第一层分支依次轮流用 BRANCH_COLORS，分支下的节点沿用所在分支的颜色。
ROOT_COLOR = "#66859C"
BRANCH_COLORS = ("#60939E", "#7B9A78", "#BE9565", "#9C85AC", "#BD8795", "#999B6B")


def source_side(index, count):
    """2–6 条：上 1 下 1；超过 6 条：上 2 下 2，其余从右侧中间出发。"""
    if count < 2:
        return "right"
    outer = 2 if count > 6 else 1
    if index < outer:
        return "top"
    if index >= count - outer:
        return "bottom"
    return "right"


class LayoutNode:
    def __init__(self, data):
        self.id = str(uuid.uuid4())[:8]
        self.text = data.get("text", "")
        self.tags = data.get("tags", [])
        self.type = data.get("type", "branch") # 'branch', 'char'
        self.edge_label = data.get("edge_label", "")
        self.residual = data.get("residual", "")
        self.children = [LayoutNode(c) for c in data.get("children", [])]
        
        # 布局属性
        self.width = 0
        self.height = 0
        self.x = 0
        self.y = 0
        self.subtree_h = 0
        self.font_md = ""

    def calc_size(self):
        """
        动态调整尺寸策略：
        1. 文本本身不含换行符。
        2. 通过控制 width 强制 Obsidian 换行。
        3. 根据字数调整 Markdown 标题级别。
        """
        # 计算可见字符数（粗略估计：中文=1，英文单词=1）
        content_len = len(self.text)
        
        if self.type == 'char':
            # 角色格子：固定用 H3，通过宽度控制换行
            # 目标：短的一行，长的两行
            self.font_md = "### " 
            if content_len < 16:
                self.width = 240
                self.height = 60
            else:
                self.width = 240  # 宽度限制住，逼迫换行
                self.height = 90  # 高度增加容纳第二行
        else:
            # 分支格子 OR 剩余信息格子 (逻辑共用)
            if content_len <= 2:
                # 极短 (如: 治愈) -> H1, 扁
                self.font_md = "# "
                self.width = 120
                self.height = 50
            elif content_len <= 5:
                # 短 (如: 非泡面番) -> H2
                self.font_md = "## "
                self.width = 160
                self.height = 55
            elif content_len <= 10:
                # 中 (如: 搞笑-漫画改) -> H3
                self.font_md = "### "
                self.width = 200
                self.height = 60
            else:
                # 长 -> 加粗, 宽
                self.font_md = "**"
                self.width = 220
                self.height = 70
                # 加粗时文本前后要加 **，由 get_full_text 处理

    def get_full_text(self):
        if self.type == "char" and "\n" in self.text:
            title, info = self.text.split("\n", 1)
            # 只量双链显示名，不把作品 ID / 笔记路径算进标题长度。
            visible = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]",
                             lambda m: m.group(2) or m.group(1), title)
            # 默认 H3 约 21px，240px 卡片原生可用正文宽度约 194px。
            # 超过两行时连续排版，年份评分可接在标题末行剩余空间。
            units = sum(0 if unicodedata.combining(c) else
                        1 if unicodedata.east_asian_width(c) in "WF" else .55
                        for c in visible)
            separator = " " if units * 21.088 > 2 * (self.width - 46) else "<br>"
            # 同一个 H3：年份评分同字号，避免另起段落带来的 16px 段间距。
            return f"### {title}{separator}{info}"
        if self.font_md == "**":
            return f"**{self.text}**"
        return f"{self.font_md}{self.text}"

class CanvasGenerator:
    def __init__(self):
        self.nodes_out = []
        self.edges_out = []

    def process(self, root_data):
        self.nodes_out, self.edges_out = [], []
        if not root_data:
            return {"nodes": [], "edges": []}
        root = LayoutNode(root_data)
        self._calc_sizes(root)
        self._calc_geometry(root)
        self._assign_coords(root, 0, 0)
        self._gen_json(root)
        return {"nodes": self.nodes_out, "edges": self.edges_out}

    def _calc_sizes(self, node):
        node.calc_size()
        for c in node.children: self._calc_sizes(c)

    def _calc_geometry(self, node):
        if not node.children:
            node.subtree_h = node.height
            return
        
        h_sum = 0
        for c in node.children:
            self._calc_geometry(c)
            h_sum += c.subtree_h
        
        # 加上间距
        h_sum += (len(node.children) - 1) * GAP_Y
        node.subtree_h = max(node.height, h_sum)

    def _assign_coords(self, node, x, center_y):
        node.x = x
        node.y = center_y - (node.height / 2)
        
        if not node.children: return
        
        # 子树总高度
        total_h = sum(c.subtree_h for c in node.children) + (len(node.children)-1)*GAP_Y
        start_y = center_y - total_h / 2
        
        child_x = x + node.width + GAP_X
        curr_y = start_y
        
        for c in node.children:
            child_center = curr_y + c.subtree_h / 2
            self._assign_coords(c, child_x, child_center)
            curr_y += c.subtree_h + GAP_Y

    def _gen_json(self, node, color=ROOT_COLOR, depth=0):
        # 1. 自身节点
        self.nodes_out.append({
            "id": node.id,
            "type": "text",
            "text": node.get_full_text(),
            "x": int(node.x), "y": int(node.y),
            "width": int(node.width), "height": int(node.height),
            "color": color
        })
        
        # 2. 剩余信息格子 (位于右侧)
        if node.residual:
            res_node = LayoutNode({"text": node.residual, "type": "branch"}) # 复用 branch 尺寸逻辑
            res_node.calc_size() # 计算尺寸
            
            res_x = node.x + node.width + 30 # 稍微远一点点
            # 垂直居中对齐
            res_y = node.y + (node.height - res_node.height) / 2
            
            res_id = f"{node.id}_res"
            self.nodes_out.append({
                "id": res_id, "type": "text",
                "text": res_node.get_full_text(),
                "x": int(res_x), "y": int(res_y),
                "width": int(res_node.width), "height": int(res_node.height),
                "color": color
            })
            # 连线
            self.edges_out.append({
                "id": str(uuid.uuid4())[:8],
                "fromNode": node.id, "fromSide": "right",
                "toNode": res_id, "toSide": "left", "color": color
            })

        # 3. 子节点连线
        for idx, child in enumerate(node.children):
            child_color = BRANCH_COLORS[idx % len(BRANCH_COLORS)] if depth == 0 else color
            edge = {
                "id": str(uuid.uuid4())[:8],
                "fromNode": node.id,
                "toNode": child.id,
                "toSide": "left",
                "color": child_color
            }
            if child.edge_label and child.edge_label.strip() != "TV":
                edge["label"] = child.edge_label
            
            edge["fromSide"] = source_side(idx, len(node.children))
                
            self.edges_out.append(edge)
            self._gen_json(child, child_color, depth + 1)
