/**
 * 「标签 → 矢量 emoji」映射表（纯数据）。
 *
 * ⚠️ vite.config.ts 会 import 这个文件，用来把用到的 fluent-emoji-flat 图标打成离线子集
 *    （virtual:emoji-subset）。所以这里**只能放纯数据**，不要 import 任何浏览器代码。
 *
 * 值是 fluent-emoji-flat 图标集里的图标名（不带 `fluent-emoji-flat:` 前缀）。
 * 查名字：https://icon-sets.iconify.design/fluent-emoji-flat/ 。名字不存在时，`vite build` 会给出「找不到这些图标」的警告。
 */

/** 播放形式（后端白名单 TV / 剧场版 / OVA / WEB / 动态漫画） */
export const PLAYBACK_EMOJI: Record<string, string> = {
  TV: 'television',
  剧场版: 'clapper-board',
  OVA: 'videocassette',
  WEB: 'globe-with-meridians',
  动态漫画: 'open-book',
}

/** 原作来源（后端只认这四类） */
export const SOURCE_EMOJI: Record<string, string> = {
  原创: 'light-bulb',
  漫画改: 'books',
  小说改: 'notebook-with-decorative-cover',
  游戏改: 'video-game',
}

/** 常见题材 */
export const GENRE_EMOJI: Record<string, string> = {
  恋爱: 'two-hearts',
  奇幻: 'person-mage',
  科幻: 'rocket',
  战斗: 'crossed-swords',
  运动: 'soccer-ball',
  日常: 'hot-beverage',
  治愈: 'herb',
  校园: 'school',
  悬疑: 'magnifying-glass-tilted-left',
  搞笑: 'face-with-tears-of-joy',
  喜剧: 'face-with-tears-of-joy',
  音乐: 'musical-note',
  偶像: 'microphone',
  百合: 'cherry-blossom',
  后宫: 'crown',
  萌: 'smiling-face-with-hearts',
  热血: 'fire',
  青春: 'sparkles',
  冒险: 'compass',
  机战: 'robot',
  萝卜: 'robot',
  推理: 'detective',
  猎奇: 'ghost',
  恐怖: 'skull',
  历史: 'japanese-castle',
  异世界: 'cyclone',
  催泪: 'crying-face',
  美食: 'rice-ball',
  魔法少女: 'magic-wand',
  童年: 'teddy-bear',
  智斗: 'brain',
  竞技: 'trophy',
  泡面番: 'steaming-bowl',
  女性向: 'ribbon',
  乙女: 'ribbon',
  BL: 'rose',
  耽美: 'rose',
  党争: 'balance-scale',
  国产: 'red-paper-lantern',
  欧美: 'world-map',
  家庭: 'house',
  职场: 'office-building',
}

/** 界面插画 / 空态用的 emoji（EmptyState 的 kind → emoji） */
export const UI_EMOJI = {
  'no-candidates': 'person-shrugging',
  'no-blocks': 'puzzle-piece',
  'no-plans': 'card-file-box',
  'no-logs': 'spiral-notepad',
  'no-result': 'game-die',
  'no-pick': 'bust-in-silhouette',
  'search-empty': 'thinking-face',
  error: 'warning',
  offline: 'electric-plug',
  success: 'party-popper',
  loading: 'hourglass-not-done',
  themes: 'artist-palette',
  canvas: 'world-map',
  data: 'bar-chart',
  clicker: 'robot',
  generic: 'sparkles',
  'not-found': 'compass',
} as const

export type UiEmojiKind = keyof typeof UI_EMOJI

/** 全部需要打进离线子集的图标名（vite.config.ts 读取） */
export const EMOJI_ICON_NAMES: string[] = Array.from(
  new Set([
    ...Object.values(PLAYBACK_EMOJI),
    ...Object.values(SOURCE_EMOJI),
    ...Object.values(GENRE_EMOJI),
    ...Object.values(UI_EMOJI),
    // 预留给主题 slots 的常用氛围 emoji（主题也可以用 unplugin-icons 静态 import 任意图标，不受这里限制）
    'crescent-moon',
    'shooting-star',
  ]),
)
