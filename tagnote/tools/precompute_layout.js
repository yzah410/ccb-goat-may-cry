#!/usr/bin/env node
// 给作品集 JSON 预先算好领地图布局，写回 layout_cache 字段。
// 用法：node tools/precompute_layout.js 输入.json [输出.json]（不给输出则覆盖输入）
const fs = require('fs'); const path = require('path');
const TagNote = require(path.resolve(__dirname, '../engine/tagnote.js'));
const [, , inp, out] = process.argv;
if (!inp) { console.error('用法：node tools/precompute_layout.js 输入.json [输出.json]'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(inp, 'utf8'));
const t0 = Date.now();
raw.layout_cache = Object.assign({}, raw.layout_cache || {}, TagNote.computeLayoutCache(raw));
fs.writeFileSync(out || inp, JSON.stringify(raw, null, 1));
console.log(`${path.basename(inp)}: ${raw.works.length} 部作品，领地图 ${raw.layout_cache.terr.cols}×${raw.layout_cache.terr.rows}，用时 ${Date.now() - t0} ms`);
