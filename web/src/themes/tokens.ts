/**
 * Token 总表（唯一真相来源）。
 *
 * - tests（themes.test.ts）用它检查每个主题的 tokens.css 覆盖率；
 * - 主题画廊用它算「token 覆盖率」；
 *
 * required = true：每个主题都应该给出自己的值（缺了会用 base 默认值兜底，并在控制台 warn）。
 * required = false：有合理默认（密度、字号档），不覆盖也没关系。
 */
export interface TokenDef {
  name: string
  group: TokenGroup
  required: boolean
  /** 这个 token 用在哪（给做主题的人看） */
  usage: string
  /** base 主题浅色的值（示例） */
  example: string
}

export type TokenGroup =
  | '背景与表面'
  | '文字'
  | '主色色阶'
  | '语义色'
  | '业务语义'
  | '边框与焦点'
  | '形状'
  | '阴影'
  | '字体'
  | '图表'
  | '效果'
  | '密度'

const t = (name: string, group: TokenGroup, usage: string, example: string, required = true): TokenDef => ({
  name,
  group,
  required,
  usage,
  example,
})

export const TOKENS: TokenDef[] = [
  // —— 背景与表面 ——
  t('--bg', '背景与表面', '页面最底层背景（壁纸主题里是壁纸没铺到的地方的底色）', '#f5f6f8'),
  t('--bg-elevated', '背景与表面', '比 --bg 抬高一层的实心底：页面里的吸顶工具条、表头、分组标题', '#fafbfc'),
  t('--surface-1', '背景与表面', '卡片、面板的底色', '#ffffff'),
  t('--surface-2', '背景与表面', '卡片里的次级区块、输入框底色、按钮 hover', '#f3f4f6'),
  t('--surface-3', '背景与表面', '按下/选中的块、分段控件的滑块底', '#e9ebef'),
  t('--surface-glass', '背景与表面', '外框（侧栏 / 顶栏 / 底部胶囊 / 分栏两侧）的底色，配合 --backdrop-blur 做毛玻璃；想要实心外框就给不透明色', 'rgb(255 255 255 / 0.72)'),
  t('--overlay', '背景与表面', '弹窗后面的遮罩', 'rgb(15 18 26 / 0.45)'),
  t('--selected-bg', '背景与表面', '选中项的底色：选中的卡片 / 组块、候选池里的「当前」行、方案库里的当前方案（不写 = --primary-50；单色或近黑主色的主题可以换成更像「选中」的颜色）', 'var(--primary-50)', false),
  // —— 文字 ——
  t('--text-1', '文字', '主文字（标题、正文）', '#16181d'),
  t('--text-2', '文字', '次要文字（说明、标签名）', '#505662'),
  t('--text-3', '文字', '辅助文字（说明、时间戳、占位符）；对 --surface-1 和 --bg 都要 ≥ 4.5:1', '#6a717d'),
  t('--text-on-primary', '文字', '主色按钮上的文字', '#ffffff'),
  t('--text-link', '文字', '链接文字', '#5b45b4'),
  // —— 主色色阶（50 最浅 → 900 最深；深色模式里要「反过来」：50 是最暗的底色） ——
  t('--primary', '主色色阶', '主按钮、选中态、进度条的实色', '#6e56cf'),
  t('--primary-50', '主色色阶', '最淡的主色底（选中行的底色）', '#f7f5ff'),
  t('--primary-100', '主色色阶', '淡主色底（hover 的选中行、徽标底）', '#efebff'),
  t('--primary-200', '主色色阶', '文字选区、较明显的淡底', '#ded6fe'),
  t('--primary-300', '主色色阶', '淡边框、分段控件选中边', '#c6b8fb'),
  t('--primary-400', '主色色阶', '图标、次要强调', '#a893f5'),
  t('--primary-500', '主色色阶', '中间色', '#8b6fec'),
  t('--primary-600', '主色色阶', '一般等于 --primary', '#6e56cf'),
  t('--primary-700', '主色色阶', '淡底（50/100）上的主色文字、图标；深色模式里是亮色', '#5b45b4'),
  t('--primary-800', '主色色阶', '淡底上的强调文字（选中项文字）；深色模式里更亮', '#493892'),
  t('--primary-900', '主色色阶', '最深（淡底上的标题色）', '#362a6c'),
  t('--primary-hover', '主色色阶', '主按钮悬停 / 菜单展开时的底色，按下时再往黑里混 14%（不写 = 主色往黑里混 14%；亮色主色可以改成往白里混）', 'color-mix(in oklab, var(--primary), black 14%)', false),
  // —— 语义色 ——
  t('--accent', '语义色', '点缀色：只用在「当前题目」星标、关键数字这类极少数地方', '#0f9f8f'),
  t('--success', '语义色', '成功（实色：图标、进度）', '#1f9d55'),
  t('--success-bg', '语义色', '成功提示的底色', '#e7f6ed'),
  t('--success-fg', '语义色', '成功提示底色上的文字', '#146c3b'),
  t('--warning', '语义色', '警告（实色）', '#d98a04'),
  t('--warning-bg', '语义色', '警告提示的底色', '#fff5e0'),
  t('--warning-fg', '语义色', '警告底色上的文字', '#8a5300'),
  t('--danger', '语义色', '危险/删除（实色）', '#dc3b3b'),
  t('--danger-bg', '语义色', '危险提示的底色', '#fdecec'),
  t('--danger-fg', '语义色', '危险底色上的文字', '#a42323'),
  t('--info', '语义色', '信息（实色）', '#2f7fe0'),
  t('--info-bg', '语义色', '信息提示的底色', '#e9f2fd'),
  t('--info-fg', '语义色', '信息底色上的文字', '#1c5aa6'),
  // —— 业务语义（含义固定，只能换色值） ——
  t('--include', '业务语义', '红块 = 纳入（永远配 ＋ 图标和「纳入」字样）', '#e0533b'),
  t('--exclude', '业务语义', '蓝块 = 排除（永远配 － 图标和「排除」字样）', '#2f6fdb'),
  t('--tag-playback', '业务语义', '播放形式标签（TV / 剧场版 / OVA / WEB / 动态漫画）', '#0891a8'),
  t('--tag-source', '业务语义', '原作来源标签（原创 / 漫画改 / 小说改 / 游戏改）', '#c2760c'),
  t('--tag-genre', '业务语义', '作品题材标签（恋爱 / 日常 / 治愈 …）', '#2e9a58'),
  t('--tag-char', '业务语义', '角色标签（黑发 / 傲娇 …）', '#c2418c'),
  t('--tag-va', '业务语义', '声优标签', '#8250c8'),
  // —— 边框与焦点 ——
  t('--border', '边框与焦点', '普通分隔线、卡片边框（深色模式用 8–15% 透明白）', '#e3e5e9'),
  t('--border-strong', '边框与焦点', '输入框边框、强调分隔', '#cfd3da'),
  t('--ring', '边框与焦点', '键盘焦点环颜色（必须在所有表面上都看得见）', '#8b6fec'),
  // —— 形状 ——
  t('--radius-sm', '形状', '徽标、小按钮', '6px'),
  t('--radius-md', '形状', '按钮、输入框', '8px'),
  t('--radius-lg', '形状', '卡片', '12px'),
  t('--radius-xl', '形状', '弹窗、大面板', '16px'),
  t('--radius-full', '形状', '胶囊（标签芯片、开关）', '9999px'),
  // —— 阴影 ——
  t('--shadow-1', '阴影', '普通卡片（极弱，几乎看不见）', '0 1px 2px rgb(16 24 40 / 0.04), 0 1px 3px rgb(16 24 40 / 0.06)'),
  t('--shadow-2', '阴影', '悬浮卡片、下拉菜单', '0 4px 12px -2px rgb(16 24 40 / 0.08), 0 2px 4px -2px rgb(16 24 40 / 0.05)'),
  t('--shadow-3', '阴影', '弹窗、命令面板', '0 16px 40px -8px rgb(16 24 40 / 0.18), 0 6px 12px -6px rgb(16 24 40 / 0.08)'),
  // —— 字体 ——
  t('--font-display', '字体', '标题字体（可以和正文不同家族，但同一界面别超过两种）', '"Inter Variable", "Noto Sans SC Variable", system-ui, sans-serif'),
  t('--font-body', '字体', '正文字体', '"Inter Variable", "Noto Sans SC Variable", system-ui, sans-serif'),
  t('--font-mono', '字体', '等宽（只给 id、日志、种子）', '"JetBrains Mono Variable", ui-monospace, Consolas, monospace'),
  t('--tracking-tight', '字体', '标题字距（收紧 2–3%）', '-0.02em'),
  t('--leading-tight', '字体', '标题行高（110–120%）', '1.15'),
  t('--fs-1', '字体', '字号第 1 档（最小：徽标、时间戳）', '12px', false),
  t('--fs-2', '字体', '字号第 2 档（辅助文字）', '13px', false),
  t('--fs-3', '字体', '字号第 3 档（正文）', '14px', false),
  t('--fs-4', '字体', '字号第 4 档（卡片标题）', '16px', false),
  t('--fs-5', '字体', '字号第 5 档（页面标题、角色名）', '20px', false),
  t('--fs-6', '字体', '字号第 6 档（最大：统计大数字）', '24px', false),
  t('--leading-body', '字体', '正文行高（150% 左右）', '1.55', false),
  t('--heading-weight', '字体', '标题字重', '600', false),
  // —— 图表 ——
  t('--chart-1', '图表', '图表第 1 色（单系列图默认用它）', '#2a78d6'),
  t('--chart-2', '图表', '图表第 2 色', '#eb6834'),
  t('--chart-3', '图表', '图表第 3 色', '#1baf7a'),
  t('--chart-4', '图表', '图表第 4 色', '#eda100'),
  t('--chart-5', '图表', '图表第 5 色', '#e87ba4'),
  t('--chart-6', '图表', '图表第 6 色', '#008300'),
  t('--chart-7', '图表', '图表第 7 色', '#4a3aa7'),
  t('--chart-8', '图表', '图表第 8 色', '#e34948'),
  t('--chart-grid', '图表', '网格线', '#e8eaee'),
  t('--chart-axis', '图表', '坐标轴文字（对表面 ≥ 4.5:1）', '#6a717d'),
  // —— 效果 ——
  t('--backdrop-blur', '效果', '毛玻璃模糊半径（外框、浮层用）', '12px'),
  t('--backdrop-opacity', '效果', '壁纸层的整体不透明度（Backdrop 自己读它）', '1'),
  t('--motion-duration', '效果', '默认过渡时长', '160ms'),
  t('--motion-ease', '效果', '默认缓动曲线（必须是 cubic-bezier(...)）', 'cubic-bezier(0.2, 0, 0, 1)'),
  // —— 密度（由 manifest.density 推导；一般不用覆盖） ——
  t('--space-unit', '密度', '间距基本单位：Tailwind 的 p-4 = 4 × 它', '4px', false),
  t('--control-h-sm', '密度', '小号控件高度', '28px', false),
  t('--control-h-md', '密度', '中号控件高度（按钮、输入框默认）', '36px', false),
  t('--control-h-lg', '密度', '大号控件高度', '44px', false),
]

export const TOKEN_NAMES: string[] = TOKENS.map((d) => d.name)
export const REQUIRED_TOKEN_NAMES: string[] = TOKENS.filter((d) => d.required).map((d) => d.name)

/** 从一段 CSS 文本里找出声明过的 token 名（只认 TOKENS 里的） */
export function declaredTokensIn(css: string): Set<string> {
  const out = new Set<string>()
  const known = new Set<string>(TOKEN_NAMES)
  // 去掉注释，免得注释里提到的 token 被算成「声明过」
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /(--[a-z0-9-]+)\s*:/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const name = (m[1] ?? '').toLowerCase()
    if (known.has(name)) out.add(name)
  }
  return out
}
