/**
 * 主题 id 别名表，目前为空；以后给主题改 id 时在这里加一条「旧 id → 新 id」。
 *
 * 加了以后，已保存的设置（浏览器 localStorage）和带 `?theme=<旧 id>` 的链接不用改，
 * 读到旧 id 时会自动映射到新 id。映射到的主题不在 `src/themes/` 里时，按「主题不存在」退回 base。
 *
 * 用在所有「读取已保存/外部传入的主题 id」的地方：
 * - `themes/registry.ts` 的 `getTheme()`（主题查找、当前主题、分屏对比）
 * - `features/settings/store.ts` 的 persist merge（localStorage 里存的主题 id）
 * - `app/themeActions.ts` 的 `?theme=` URL 解析
 * - `index.html` 首帧脚本（内联了一份同样的别名表，改这里的话记得也改那边）
 */
export const THEME_ID_ALIASES: Record<string, string> = {}

/** 按别名表把主题 id 换成实际 id；不在表里就原样返回 */
export function resolveThemeId(id: string): string {
  return THEME_ID_ALIASES[id] ?? id
}
