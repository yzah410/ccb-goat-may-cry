# 测试用的「主题」文件夹（不会被网站加载）

`src/themes/themes.test.ts` 的「主题隔离」测试用它们验证：坏一个主题只跳过它自己。

| 文件夹 | 模拟的坑 |
|---|---|
| `good/` | 正常主题（对照组） |
| `throws/` | `slots.tsx` 模块一被求值就抛错（代码写错了） |
| `missing-import/` | `fonts.ts` import 了一个不存在的 `./extras.css`（常见的错误：写了 import，文件却没建） |
| `no-default/` | `manifest.ts` 忘了 `export default` |

注册表只收集 `src/themes/*/`，这里的文件夹不会出现在网站里。
