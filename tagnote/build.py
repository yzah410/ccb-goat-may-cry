"""构建：src/ → engine/ 与 examples/
  engine/tagnote.js        UMD（<script> 引入后得到全局 TagNote；也可 require）
  engine/tagnote.esm.js    ES Module（import TagNote from './tagnote.esm.js'）
  examples/standalone.html 单文件页面片段（不含 doctype 和 html / head，需要嵌进别的页面使用）
  examples/2018百合标签笔记.html  可双击打开的本地完整页面
  examples/pane.html       格子布局（layout:'pane'）示例：两个格子并排各挂一个实例（test/pane.js 用它）
  engine/tagnote.esm.d.ts  类型声明（来自 src/tagnote.d.ts）
另外把 tagnote.esm.js + tagnote.esm.d.ts 复制到各宿主的 vendor 目录（见 HOSTS；目录不存在就跳过）。
用法：python3 build.py
"""
import json, pathlib, shutil
root = pathlib.Path(__file__).parent
src = root / 'src'; eng = root / 'engine'; ex = root / 'examples'; eng.mkdir(exist_ok=True); ex.mkdir(exist_ok=True)
css = (src / 'tagnote.css').read_text(encoding='utf-8')
core = (src / 'tagnote.core.js').read_text(encoding='utf-8')
assert '/*__CSS__*/""' in core
engine = core.replace('/*__CSS__*/""', json.dumps(css, ensure_ascii=False))
(eng / 'tagnote.js').write_text(engine, encoding='utf-8')
# ESM：把 UMD 包装换成 export default
body = engine.split("})(typeof globalThis !== 'undefined' ? globalThis : this, function () {", 1)[1]
body = body.rsplit('});', 1)[0]
esm = engine.split('(function (root, factory)')[0] + 'const TagNote = (function () {' + body + '})();\nexport default TagNote;\n'
(eng / 'tagnote.esm.js').write_text(esm, encoding='utf-8')
(eng / 'tagnote.esm.d.ts').write_text((src / 'tagnote.d.ts').read_text(encoding='utf-8'), encoding='utf-8')
# 宿主：出题器前端（web/）、Obsidian 插件。宿主里的这两个文件只由这里生成，不要手改
HOSTS = [root.parent / 'web' / 'src' / 'vendor' / 'tagnote', root / 'obsidian-plugin' / 'vendor']
for h in HOSTS:
    if not h.parent.parent.exists():
        print('skip', h); continue
    h.mkdir(parents=True, exist_ok=True)
    for f in ('tagnote.esm.js', 'tagnote.esm.d.ts'):
        shutil.copyfile(eng / f, h / f)
    print('copied ->', h)
def safe(s): return s.replace('</', '<\\/')
data = json.loads((root / 'data' / 'works_2018_yuri.json').read_text(encoding='utf-8'))
covers_file = root / 'data' / 'covers_2018_yuri.json'  # 可选的封面数据（subject_id → 封面地址）；没有就生成不带封面的示例
covers = json.loads(covers_file.read_text(encoding='utf-8')) if covers_file.exists() else {}
page = (src / 'page.html').read_text(encoding='utf-8')
out = page.replace('/*__DATA__*/', safe(json.dumps(data, ensure_ascii=False))) \
          .replace('/*__COVERS__*/', safe(json.dumps(covers))) \
          .replace('/*__ENGINE__*/', engine.replace('</script', '<\\/script')) \
          .replace('/*__PAGE__*/', (src / 'page.js').read_text(encoding='utf-8'))
(ex / 'standalone.html').write_text(out, encoding='utf-8')
(ex / '2018百合标签笔记.html').write_text('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>img{max-width:100%}[hidden]{display:none!important}</style></head><body>' + out + '</body></html>', encoding='utf-8')
# 格子布局示例：两个固定高度的格子并排，各挂一个 layout:'pane' 实例（引擎用 <script src="../engine/tagnote.js">）
pane = (src / 'pane.html').read_text(encoding='utf-8') \
          .replace('/*__DATA__*/', safe(json.dumps(data, ensure_ascii=False))) \
          .replace('/*__COVERS__*/', safe(json.dumps(covers)))
(ex / 'pane.html').write_text(pane, encoding='utf-8')
print('ok', len(engine), len(out))
