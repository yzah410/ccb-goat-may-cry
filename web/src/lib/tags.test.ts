/**
 * 按模式分栏（lib/tags.ts 后半段 + tagRules.json）。
 * 标签组合按接口返回的样子构造（/v2/character/{id}?mode=&n=6 的 grid.tags，或者 profile_tag 里格子显示的那些），顺序和接口返回一致。
 * 期望值是按 tagRules.json 的列表手推的（组内按列表顺序；不在任何列表里的按原顺序进「+N」）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  columnizeWorkTags,
  groupWorkTags,
  isHiddenWorkTag,
  PLAYBACK_WHITELIST,
  setAnimeTierOverride,
  SOURCE_TAGS,
  statsTagSections,
  tagRuleSet,
  type WorkTagColumns,
} from './tags'
import rules from './tagRules.json'

/** 分栏结果写成好读的样子：每栏是「组: 标签…」的列表（降到第二栏的组标一个「↓」） */
function view(c: WorkTagColumns) {
  const fmt = (hits: WorkTagColumns['col1']) => hits.map((h) => `${h.group.key}${h.group.demoted ? '↓' : ''}: ${h.tags.join(' ')}`)
  return { col1: fmt(c.col1), col2: fmt(c.col2), other: c.other }
}
const flat = (hits: WorkTagColumns['col1']) => hits.flatMap((h) => h.tags)

// ---------------------------------------------------------------- 按接口返回构造的数据（grid.tags 的顺序）
// 动画模式
const GOTOH_HITORI = ['芳文社', '音乐', 'CloverWorks', '日常', '轻百合', '漫画改', '乐队题材', '搞笑', 'TV', '百合', '剧场版', '斎藤圭一郎', '乐队', '总集篇']
const FRIEREN = ['漫画改', '治愈', '奇幻', '公路片', 'MADHouse', 'TV', '旅行', '寿命论', '异世界', '斋藤圭一郎', '日本', '葬送的芙莉莲', '催泪', '战斗']
// 游戏模式
const AMIYA = ['手游', '塔防', '鹰角网络', '国产', '明日方舟', '抽卡', 'Android', '中国', '阿米娅']
const RANCE = ['alicesoft', 'Galgame', '兰斯', 'SLG', '战兰', 'PC', '战国兰斯', '上杉谦信', 'RPG', '神作', '鬼畜', 'R18']
const PAIMON = ['miHoYo', '开放世界', '手游', '国产', '米哈游', '版本更新频繁', 'PC', '玩法融合', '同类对比', 'RPG', 'ARPG']
// 书籍模式
const LUFFY = ['海贼王', '尾田荣一郎', 'JUMP', '热血', '漫画', '少年漫画', '集英社', '燃', '神作', '少年JUMP', 'OP', '冒险']
const ROXY = ['轻小说', '异世界', '后宫', '無職転生', '奇幻', '理不尽な孫の手', '穿越', '漫画', '情感', '小说改', '小说', '日本', '魔幻']
const CC = ['漫画', 'CodeGeass', '鲁路修', '几百年前', '画功不行', '已完结']
// 三次元模式
const SHOTARO = ['假面骑士', '特摄', '仮面ライダー', '剧场版', '菅田将暉', '东映', 'TV', '桐山涟', '日本']
const GINTOKI = ['真人版', '漫画改', '小栗旬', '日影', '银魂', '电影', '日剧', '映画', '日本', '桥本环奈', '菅田将暉', '空知英秋', '柳楽優弥']
const IRON_MAN = ['电影', '漫威', 'marvel', '欧美', '科幻', '超级英雄', '美国', '钢铁侠', '复仇者联盟', '动作']
// 全部模式
const ARTORIA_ALL = ['Fate', 'Type-Moon', 'ufotable', '游戏改', 'TV', '战斗', '虚渊玄', '奇幻', 'UBW', 'Saber', 'FateStayNight', '剧场版']
const AMIYA_ALL = ['游戏改', '明日方舟', 'YostarPictures', '鹰角网络', '手游', '塔防', '国产', 'TV', '战斗', '科幻', '中日合作']
const PAIMON_ALL = PAIMON
/** 胡桃（莉可丽丝）：游戏模式下没有游戏登场，走退回规则（grid.fallback = true），标签是动画的 */
const KURUMI_LYCORIS = ['原创', '百合', 'A-1Pictures', '战斗', '日常', 'TV', '足立慎吾', '泡面番', '无法预测的命运之舞台', '日本']

describe('按模式分栏：动画', () => {
  it('后藤一里：漫画改 TV 剧场版 | 百合 日常 搞笑 音乐 CloverWorks | +6', () => {
    expect(view(columnizeWorkTags(GOTOH_HITORI, 'anime'))).toEqual({
      col1: ['anime.source: 漫画改', 'anime.playback: TV 剧场版'],
      col2: ['anime.genre1: 百合 日常 搞笑', 'anime.genre2: 音乐', 'anime.studio: CloverWorks'],
      other: ['芳文社', '轻百合', '乐队题材', '斎藤圭一郎', '乐队', '总集篇'],
    })
  })
  it('芙莉莲：漫画改 TV | 奇幻 战斗 治愈 异世界 催泪 MADHouse | +6（日本在 +N 里）', () => {
    expect(view(columnizeWorkTags(FRIEREN, 'anime'))).toEqual({
      col1: ['anime.source: 漫画改', 'anime.playback: TV'],
      col2: ['anime.genre1: 奇幻 战斗 治愈', 'anime.genre2: 异世界 催泪', 'anime.studio: MADHouse'],
      other: ['公路片', '旅行', '寿命论', '斋藤圭一郎', '日本', '葬送的芙莉莲'],
    })
  })
  it('动画的第二栏 / 其余和 groupWorkTags 逐项一样；第一栏 = SOURCE_TAGS + PLAYBACK_WHITELIST', () => {
    for (const tags of [GOTOH_HITORI, FRIEREN, ARTORIA_ALL, AMIYA_ALL, ['治愈', 'MAPPA', '日常', '间谍过家家', '热血', '2022', 'TV']]) {
      const c = columnizeWorkTags(tags, 'anime')
      const g = groupWorkTags(tags)
      const byId = (id: string) => c.col2.find((h) => h.group.id === id)?.tags ?? []
      expect(byId('genre1')).toEqual(g.genrePrimary)
      expect(byId('genre2')).toEqual(g.genreSecondary)
      expect(byId('studio')).toEqual(g.studios)
      expect(c.other).toEqual(g.other)
      expect(c.col1.find((h) => h.group.id === 'source')?.tags ?? []).toEqual(SOURCE_TAGS.filter((t) => tags.includes(t)))
      expect(c.col1.find((h) => h.group.id === 'playback')?.tags ?? []).toEqual(PLAYBACK_WHITELIST.filter((t) => tags.includes(t)))
    }
  })
  it('动画的规则列表和 lib/tags.ts 里的常量一致', () => {
    const anime = tagRuleSet('anime').groups
    expect(anime.map((g) => g.id)).toEqual(['source', 'playback', 'genre1', 'genre2', 'studio'])
    expect(anime[0]!.tags).toEqual([...SOURCE_TAGS])
    expect(anime[1]!.tags).toEqual([...PLAYBACK_WHITELIST])
    // genre1 / genre2 / studio 三组：把每个标签单独丢进 groupWorkTags，看它落在哪组
    for (const g of anime.slice(2)) {
      const want = g.id === 'genre1' ? 'genrePrimary' : g.id === 'genre2' ? 'genreSecondary' : 'studios'
      for (const t of g.tags) expect(groupWorkTags([t])[want]).toEqual([t])
    }
  })
})

describe('按模式分栏：游戏（第一栏只有平台）', () => {
  it('阿米娅：手游 Android | 塔防 抽卡 国产 中国 鹰角网络 | +2', () => {
    expect(view(columnizeWorkTags(AMIYA, 'game'))).toEqual({
      col1: ['game.platform: 手游 Android'],
      col2: ['game.gameplay: 塔防 抽卡', 'game.genre: 国产 中国', 'game.maker: 鹰角网络'],
      other: ['明日方舟', '阿米娅'],
    })
  })
  it('兰斯：PC | Galgame RPG SLG R18 alicesoft | +6（分级 R18 在第二栏）', () => {
    expect(view(columnizeWorkTags(RANCE, 'game'))).toEqual({
      col1: ['game.platform: PC'],
      col2: ['game.gameplay: Galgame RPG SLG', 'game.nature: R18', 'game.maker: alicesoft'],
      other: ['兰斯', '战兰', '战国兰斯', '上杉谦信', '神作', '鬼畜'],
    })
  })
  it('派蒙：PC 手游 | RPG ARPG 开放世界 国产 miHoYo 米哈游 | +3', () => {
    expect(view(columnizeWorkTags(PAIMON, 'game'))).toEqual({
      col1: ['game.platform: PC 手游'],
      col2: ['game.gameplay: RPG ARPG 开放世界', 'game.genre: 国产', 'game.maker: miHoYo 米哈游'],
      other: ['版本更新频繁', '玩法融合', '同类对比'],
    })
  })
})

describe('按模式分栏：书籍（第一栏 = 形式 + 状态；受众、来源、出版 / 连载在第二栏）', () => {
  it('路飞：漫画 | 热血 冒险 少年漫画 燃 集英社 JUMP 少年JUMP | +4（连载杂志并进了出版 / 连载）', () => {
    expect(view(columnizeWorkTags(LUFFY, 'book'))).toEqual({
      col1: ['book.form: 漫画'],
      col2: ['book.genre1: 热血 冒险', 'book.audience: 少年漫画', 'book.genre2: 燃', 'book.publisher: 集英社 JUMP 少年JUMP'],
      other: ['海贼王', '尾田荣一郎', '神作', 'OP'],
    })
  })
  it('洛琪希：漫画 轻小说 小说 | 奇幻 异世界 后宫 穿越 小说改 | +5（来源在第二栏）', () => {
    expect(view(columnizeWorkTags(ROXY, 'book'))).toEqual({
      col1: ['book.form: 漫画 轻小说 小说'],
      col2: ['book.genre1: 奇幻 异世界 后宫', 'book.genre2: 穿越', 'book.bsource: 小说改'],
      other: ['無職転生', '理不尽な孫の手', '情感', '日本', '魔幻'],
    })
  })
  it('C.C.：漫画 已完结（状态在第一栏）', () => {
    expect(view(columnizeWorkTags(CC, 'book'))).toEqual({
      col1: ['book.form: 漫画', 'book.status: 已完结'],
      col2: [],
      other: ['CodeGeass', '鲁路修', '几百年前', '画功不行'],
    })
  })
})

describe('按模式分栏：三次元（第一栏 = 基础形式 + 来源；特摄、日剧、真人版在第二栏）', () => {
  it('左翔太郎：TV 剧场版 | 特摄 假面骑士 仮面ライダー 东映 | +3（日本在 +N 里）', () => {
    expect(view(columnizeWorkTags(SHOTARO, 'real'))).toEqual({
      col1: ['real.rform: TV 剧场版'],
      col2: ['real.genre: 特摄', 'real.series: 假面骑士 仮面ライダー', 'real.company: 东映'],
      other: ['菅田将暉', '桐山涟', '日本'],
    })
  })
  it('坂田银时：电影 映画 漫画改 | 日剧 真人版 | +8', () => {
    expect(view(columnizeWorkTags(GINTOKI, 'real'))).toEqual({
      col1: ['real.rform: 电影 映画', 'real.rsource: 漫画改'],
      col2: ['real.rkind: 日剧 真人版'],
      other: ['小栗旬', '日影', '银魂', '日本', '桥本环奈', '菅田将暉', '空知英秋', '柳楽優弥'],
    })
  })
  it('钢铁侠：电影 | 科幻 动作 超级英雄 漫威 marvel 欧美 美国 | +2', () => {
    expect(view(columnizeWorkTags(IRON_MAN, 'real'))).toEqual({
      col1: ['real.rform: 电影'],
      col2: ['real.genre: 科幻 动作 超级英雄', 'real.series: 漫威 marvel 欧美 美国'],
      other: ['钢铁侠', '复仇者联盟'],
    })
  })
})

describe('混合规则（全部模式）：有动画登场 → 第一栏只留动画的来源 + 播放形式', () => {
  it('阿尔托莉雅（有动画）：游戏改 TV 剧场版 | 奇幻 战斗 ufotable Type-Moon | +5', () => {
    expect(view(columnizeWorkTags(ARTORIA_ALL, 'all', { hasAnime: true }))).toEqual({
      col1: ['anime.source: 游戏改', 'anime.playback: TV 剧场版'],
      col2: ['anime.genre1: 奇幻 战斗', 'anime.studio: ufotable', 'game.maker: Type-Moon'],
      other: ['Fate', '虚渊玄', 'UBW', 'Saber', 'FateStayNight'],
    })
  })
  it('阿米娅（有动画）：游戏的「平台」降到第二栏，排在动画的组后面', () => {
    expect(view(columnizeWorkTags(AMIYA_ALL, 'all', { hasAnime: true }))).toEqual({
      col1: ['anime.source: 游戏改', 'anime.playback: TV'],
      col2: ['anime.genre1: 科幻 战斗', 'anime.genre2: 国产', 'game.platform↓: 手游', 'game.gameplay: 塔防', 'game.maker: 鹰角网络'],
      other: ['明日方舟', 'YostarPictures', '中日合作'],
    })
  })
  it('C.C.（有动画、这组标签是书籍的）：书籍的形式、状态都降到第二栏，第一栏是空的', () => {
    expect(view(columnizeWorkTags(CC, 'all', { hasAnime: true }))).toEqual({
      col1: [],
      col2: ['book.form↓: 漫画', 'book.status↓: 已完结'],
      other: ['CodeGeass', '鲁路修', '几百年前', '画功不行'],
    })
  })
})

describe('混合规则（全部模式）：没有动画登场 → 四个模式的第一栏都留在第一栏', () => {
  it('派蒙（没有动画）：PC 手游 | 国产 RPG ARPG 开放世界 miHoYo 米哈游（第二栏动画的组在最前）', () => {
    expect(view(columnizeWorkTags(PAIMON_ALL, 'all', { hasAnime: false }))).toEqual({
      col1: ['game.platform: PC 手游'],
      col2: ['anime.genre2: 国产', 'game.gameplay: RPG ARPG 开放世界', 'game.maker: miHoYo 米哈游'],
      other: ['版本更新频繁', '玩法融合', '同类对比'],
    })
  })
  it('同一组标签，有 / 没有动画登场的差别只在「别的模式的第一栏」', () => {
    expect(view(columnizeWorkTags(AMIYA_ALL, 'all', { hasAnime: false }))).toEqual({
      col1: ['anime.source: 游戏改', 'anime.playback: TV', 'game.platform: 手游'],
      col2: ['anime.genre1: 科幻 战斗', 'anime.genre2: 国产', 'game.gameplay: 塔防', 'game.maker: 鹰角网络'],
      other: ['明日方舟', 'YostarPictures', '中日合作'],
    })
    expect(view(columnizeWorkTags(CC, 'all', { hasAnime: false }))).toEqual({
      col1: ['book.form: 漫画', 'book.status: 已完结'],
      col2: [],
      other: ['CodeGeass', '鲁路修', '几百年前', '画功不行'],
    })
  })
  it('接口没给 has_anime 字段时（undefined）按「没有动画登场」算', () => {
    expect(columnizeWorkTags(AMIYA_ALL, 'all')).toEqual(columnizeWorkTags(AMIYA_ALL, 'all', { hasAnime: false }))
    expect(tagRuleSet('all').kind).toBe('mixed')
    expect(tagRuleSet('all', { hasAnime: true }).kind).toBe('mixed-anime')
  })
  it('不认识的模式也按混合规则', () => {
    expect(tagRuleSet(undefined).kind).toBe('mixed')
    expect(tagRuleSet('music').kind).toBe('mixed')
  })
  it('一个标签在几个模式里都有：按 union_order 第一个出现的算', () => {
    expect(rules.union_order).toEqual(['anime', 'game', 'book', 'real'])
    // 女性向：动画的第二栏（黄）、游戏的题材、书籍的受众 → 动画
    expect(columnizeWorkTags(['女性向'], 'all').col2[0]!.group.key).toBe('anime.genre2')
    // 原创：动画的来源（第一栏）、书籍的来源（第二栏）、三次元的来源 → 动画，第一栏
    expect(columnizeWorkTags(['原创'], 'all').col1[0]!.group.key).toBe('anime.source')
    // 东映：动画的制作公司、三次元的公司 → 动画
    expect(columnizeWorkTags(['东映'], 'all').col2[0]!.group.key).toBe('anime.studio')
  })
})

describe('退回规则（grid.fallback = true）也用混合规则', () => {
  it('胡桃（莉可丽丝）在游戏模式、有动画登场：只用游戏规则第一栏是空的；按混合规则是「原创 TV」', () => {
    expect(columnizeWorkTags(KURUMI_LYCORIS, 'game').col1).toEqual([])
    expect(view(columnizeWorkTags(KURUMI_LYCORIS, 'game', { fallback: true, hasAnime: true }))).toEqual({
      col1: ['anime.source: 原创', 'anime.playback: TV'],
      col2: ['anime.genre1: 战斗 百合 日常', 'anime.genre2: 泡面番', 'anime.studio: A-1Pictures'],
      other: ['足立慎吾', '无法预测的命运之舞台', '日本'],
    })
  })
  it('胡桃（原神）在动画模式、没有动画登场：第一栏是游戏的平台', () => {
    expect(view(columnizeWorkTags(PAIMON, 'anime', { fallback: true, hasAnime: false }))).toEqual({
      col1: ['game.platform: PC 手游'],
      col2: ['anime.genre2: 国产', 'game.gameplay: RPG ARPG 开放世界', 'game.maker: miHoYo 米哈游'],
      other: ['版本更新频繁', '玩法融合', '同类对比'],
    })
  })
  it('没有退回规则时 has_anime 不起作用（单个模式照自己的规则）', () => {
    expect(columnizeWorkTags(AMIYA, 'game', { hasAnime: true })).toEqual(columnizeWorkTags(AMIYA, 'game'))
  })
})

describe('年份和「日本」进不了第一 / 二栏', () => {
  const tags = ['2019', '日本', '百合', 'TV', '漫画', '手游', '特摄', '2022']
  const cases = [
    ['anime', {}],
    ['game', {}],
    ['book', {}],
    ['real', {}],
    ['all', { hasAnime: false }],
    ['all', { hasAnime: true }],
    ['game', { fallback: true }],
  ] as const
  for (const [mode, opts] of cases) {
    it(`${mode} ${JSON.stringify(opts)}`, () => {
      const c = columnizeWorkTags(tags, mode, opts)
      const shown = [...flat(c.col1), ...flat(c.col2)]
      expect(shown).not.toContain('日本')
      expect(shown).not.toContain('2019')
      expect(shown).not.toContain('2022')
      // 年份连「+N」都不进；「日本」进「+N」
      expect(c.other).toContain('日本')
      expect(c.other).not.toContain('2019')
      expect(c.other).not.toContain('2022')
    })
  }
  it('isHiddenWorkTag 只认四位数', () => {
    expect(isHiddenWorkTag('2019')).toBe(true)
    expect(isHiddenWorkTag('201')).toBe(false)
    expect(isHiddenWorkTag('2019年')).toBe(false)
    expect(isHiddenWorkTag('日本')).toBe(false)
  })
  it('重复的标签只算一次；空值不崩', () => {
    expect(columnizeWorkTags(['TV', 'TV', '奇幻', '奇幻', '神作', '神作'], 'anime').other).toEqual(['神作'])
    expect(columnizeWorkTags(null, 'anime')).toMatchObject({ col1: [], col2: [], other: [] })
    expect(columnizeWorkTags(undefined, undefined)).toMatchObject({ col1: [], col2: [], other: [] })
  })
})

describe('每个模式的规则本身（tagRules.json）', () => {
  const col1Ids = (m: 'anime' | 'game' | 'book' | 'real') => tagRuleSet(m).groups.filter((g) => g.column === 1).map((g) => g.id)
  it('第一栏只有基础属性：动画 来源 + 播放形式；游戏 平台；书籍 形式 + 状态；三次元 形式 + 来源', () => {
    expect(rules.version).toBe(1)
    expect(col1Ids('anime')).toEqual(['source', 'playback'])
    expect(col1Ids('game')).toEqual(['platform'])
    expect(col1Ids('book')).toEqual(['form', 'status'])
    expect(col1Ids('real')).toEqual(['rform', 'rsource'])
  })
  it('同一个模式里一个标签只在一组；「日本」不在任何组里', () => {
    for (const m of ['anime', 'game', 'book', 'real'] as const) {
      const all = tagRuleSet(m).groups.flatMap((g) => g.tags)
      expect(new Set(all).size).toBe(all.length)
      expect(all).not.toContain('日本')
    }
  })
  it('混合规则（有动画登场）里第二栏是动画的组在前，其余按 union_order', () => {
    const modes = tagRuleSet('all', { hasAnime: true }).groups.filter((g) => g.column === 2).map((g) => g.mode)
    const order = ['anime', 'game', 'book', 'real']
    for (let i = 1; i < modes.length; i++) expect(order.indexOf(modes[i]!)).toBeGreaterThanOrEqual(order.indexOf(modes[i - 1]!))
    expect(tagRuleSet('all', { hasAnime: true }).groups.filter((g) => g.column === 1).map((g) => g.key)).toEqual(['anime.source', 'anime.playback'])
  })
})

describe('统计页「最常见的标签」按模式分节（第一栏每组一节）', () => {
  it('动画：来源 / 播放形式两节 + 作品标签；来源、播放形式由后端单独统计', () => {
    const r = statsTagSections(
      {
        top_work_tags: [
          { tag: '战斗', count: 45 },
          { tag: '百合', count: 39 },
          { tag: '泡面番', count: 26 },
          { tag: 'MAPPA', count: 20 },
          { tag: '卖肉', count: 12 },
          { tag: '日本', count: 10 },
        ],
        source: { 漫画改: 54, 原创: 37 },
        playback: { TV: 109, 剧场版: 27, OVA: 0, WEB: 13, 动态漫画: 0 },
      },
      'anime',
    )
    expect(r.sections.map((s) => [s.label, s.items.map((i) => `${i.tag} ${i.count}`)])).toEqual([
      ['来源', ['漫画改 54', '原创 37']],
      ['播放形式', ['TV 109', '剧场版 27', 'WEB 13']],
    ])
    expect(r.workTags.map((i) => [i.tag, i.style])).toEqual([
      ['战斗', 'genre-primary'],
      ['百合', 'genre-primary'],
      ['泡面番', 'genre-secondary'],
      ['MAPPA', 'studio'],
      ['卖肉', null],
      ['日本', null],
    ])
  })
  it('游戏：只有「平台」一节（分级 R18 进作品标签）；作品标签最多 16 个', () => {
    const top = [
      { tag: '手游', count: 80 },
      { tag: 'Galgame', count: 70 },
      { tag: 'PC', count: 60 },
      { tag: 'R18', count: 30 },
      { tag: '国产', count: 20 },
      ...Array.from({ length: 30 }, (_, i) => ({ tag: `梗${i}`, count: 4 - i / 100 })),
    ]
    const r = statsTagSections({ top_work_tags: top, source: { 原创: 5 }, playback: { TV: 0, 剧场版: 0 } }, 'game')
    expect(r.sections.map((s) => [s.label, s.items.map((i) => i.tag)])).toEqual([['平台', ['手游', 'PC']]])
    expect(r.workTags.slice(0, 4).map((i) => [i.tag, i.style])).toEqual([
      ['Galgame', 'genre-primary'],
      ['R18', 'genre-secondary'],
      ['国产', 'genre-secondary'],
      ['原创', null],
    ])
    expect(r.workTags).toHaveLength(16)
  })
  it('书籍：形式 / 状态两节；三次元：形式 / 来源两节', () => {
    const book = statsTagSections({ top_work_tags: [{ tag: '漫画', count: 9 }, { tag: '少年漫画', count: 8 }, { tag: '已完结', count: 3 }], source: { 小说改: 2 } }, 'book')
    expect(book.sections.map((s) => [s.label, s.items.map((i) => i.tag)])).toEqual([
      ['形式', ['漫画']],
      ['状态', ['已完结']],
    ])
    expect(book.workTags.map((i) => i.tag)).toEqual(['少年漫画', '小说改'])
    const real = statsTagSections({ top_work_tags: [{ tag: '特摄', count: 9 }, { tag: '电视剧', count: 5 }], source: { 漫画改: 4 }, playback: { TV: 7 } }, 'real')
    expect(real.sections.map((s) => [s.label, s.items.map((i) => i.tag)])).toEqual([
      ['形式', ['TV', '电视剧']],
      ['来源', ['漫画改']],
    ])
    expect(real.workTags.map((i) => [i.tag, i.style])).toEqual([['特摄', 'genre-primary']])
  })
  it('全部：按「没有动画登场」的混合规则分节，同名的节合并（动画和三次元都有「来源」，书籍和三次元都有「形式」）', () => {
    const r = statsTagSections(
      { top_work_tags: [{ tag: '漫改电影', count: 3 }, { tag: '电影', count: 9 }, { tag: '漫画', count: 7 }, { tag: '手游', count: 6 }], source: { 原创: 5 } },
      'all',
    )
    expect(r.sections.map((s) => [s.label, s.items.map((i) => i.tag)])).toEqual([
      ['来源', ['原创', '漫改电影']],
      ['平台', ['手游']],
      ['形式', ['电影', '漫画']],
    ])
  })
  it('没有统计数据时是空的，不崩', () => {
    expect(statsTagSections(null, 'anime')).toEqual({ sections: [], workTags: [] })
  })
})

describe('标签分档覆盖动画的题材两组（设置页 / 开局问卷）', () => {
  afterEach(() => setAnimeTierOverride(null))

  it('传 null = 按 tagRules.json 原样分组', () => {
    const before = view(columnizeWorkTags(FRIEREN, 'anime'))
    setAnimeTierOverride({ primary: ['音乐'], secondary: [] })
    setAnimeTierOverride(null)
    expect(view(columnizeWorkTags(FRIEREN, 'anime'))).toEqual(before)
  })
  it('第 1 档 → 加粗那组；第 2–4 档 → 普通题材；tagRules.json 的 genre2 里不在任何一档的标签仍归普通题材', () => {
    setAnimeTierOverride({ primary: ['音乐', '日常'], secondary: ['百合', '搞笑'] })
    expect(view(columnizeWorkTags(GOTOH_HITORI, 'anime')).col2).toEqual([
      'anime.genre1: 音乐 日常',
      'anime.genre2: 百合 搞笑',
      'anime.studio: CloverWorks',
    ])
    const genre2 = tagRuleSet('anime').groups.find((g) => g.id === 'genre2')!.tags
    expect(genre2.slice(0, 2)).toEqual(['百合', '搞笑'])
    expect(genre2).not.toContain('音乐')
    expect(genre2).toContain('催泪')
  })
  it('混合规则里动画的题材组也跟着换', () => {
    setAnimeTierOverride({ primary: ['战斗'], secondary: ['奇幻'] })
    const g1 = tagRuleSet('all', { hasAnime: true }).groups.find((g) => g.mode === 'anime' && g.id === 'genre1')!
    expect(g1.tags).toEqual(['战斗'])
  })
})
