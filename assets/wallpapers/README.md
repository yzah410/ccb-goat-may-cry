# 壁纸（可选）

应用不自带壁纸。这个目录没有图片时一切照常：主题会改用纯色或渐变背景，页面里也不会出现空白或坏图。
想用自己的壁纸，按下面的结构放进来即可。

## 目录结构

```
assets/wallpapers/
  full/<slug>.webp     大图，建议 1920 宽
  thumb/<slug>.webp    缩略图，建议 480 宽（分屏对比、主题画廊用它，省流量）
  palette.json         壁纸清单
```

- `<slug>` 用小写字母、数字、短横线，例如 `city-night`。同一张图在 `full/`、`thumb/` 和 `palette.json` 里用同一个 slug。
- 图片只认 `.webp`（路径是固定的 `full/<slug>.webp` 和 `thumb/<slug>.webp`）。
- 开发时 Vite 把这个目录映射到 `/wallpapers/*`；构建时把 `full/`、`thumb/`、`palette.json` 复制进 `dist/wallpapers/`。目录不存在或没有图片时，构建不会报错，也不会生成 `dist/wallpapers/`。
- 改完 `palette.json` 后刷新页面；开发服务器没反应时重启 `npm run dev`。

## palette.json

一个数组，每张壁纸一项。**只有 `slug` 是必填的**：

```json
[
  { "slug": "city-night" },
  { "slug": "forest", "blurDataURL": "data:image/webp;base64,UklGR...", "colors": ["#10142a", "#2b3566"] }
]
```

| 字段 | 说明 |
|---|---|
| `slug` | 必填。对应 `full/<slug>.webp` 和 `thumb/<slug>.webp` |
| `blurDataURL` | 可选。16 像素宽的 WebP data URL，大图加载完之前先显示这张模糊图。不写就直接等大图淡入 |
| `colors` | 可选。主色的 hex 数组，主题想按壁纸取色时用 |
| `width` / `height` | 可选。大图的像素尺寸，默认 1920 × 1080 |
| `tone` / `temperature` / `avgLuminance` / `dominantHue` / `subject` / `mood` / `file` | 可选的描述信息，应用本身不读，主题或你自己的脚本可以用 |

`palette.json` 不存在、不是数组、或某一项没有 `slug` 时，对应的壁纸会被忽略，应用不会报错。`palette.json` 要手写或用自己的脚本生成，应用不会自动扫描图片目录。

## 主题怎么用壁纸

主题通过 slug 引用壁纸（`web/src/themes/<主题>/manifest.ts` 里的 `wallpapers`、`previewWallpaper`）。引用的 slug 没有对应图片时，那个位置就不显示图片，不会报错。

自带的「月夜·萤火」（`moonlit`）主题按页面引用 `night-1` 到 `night-8`，对应关系在 `web/src/themes/moonlit/scenes.ts`。放进这几个 slug 的图片，每个页面就会在右上角透出对应的夜景；没有时，这个主题用纯 CSS 画的夜空、月晕和萤火。想换成别的 slug，改 `scenes.ts` 里的 `slug` 即可。
