#!/usr/bin/env python3
"""作品集 JSON → Obsidian 笔记（.md），供 TagNote 插件打开。
实现在 backend/v2/tagnote_note.py（出题器里下载导图笔记用的是同一份）；这里只是命令行入口。
用法：python make_obsidian_note.py 作品集.json 输出.md
"""
import json, pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from backend.v2.tagnote_note import make_note  # noqa: E402

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
    # 固定写 LF：Windows 默认写 CRLF，Obsidian 在 Markdown 视图里打开过就会改存成 LF，文件无故变成「已修改」
    pathlib.Path(sys.argv[2]).write_text(make_note(data), encoding='utf-8', newline='\n')
    print('写入', sys.argv[2])
