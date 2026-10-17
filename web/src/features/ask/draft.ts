/**
 * 「问数据」AI 回答的边写边解析：后端让 AI 按这个顺序写纯文本（和 backend/v2/ai.py 的 ASK_FORMAT 一致）——
 *
 *   说明：这条查询怎么算的
 *   范围：统计的是库里哪些作品 / 角色
 *   ```sql
 *   SELECT …
 *   ```
 *   存为：character character_id
 *
 * 流式时文字随时会被切断在任何位置（例如刚写到「范」），这里每次拿到目前为止的全文重新解析，
 * 解析不了的部分先不显示，不报错。最终结果以后端 result 事件里的字段为准。
 */
export interface AskDraft {
  explanation: string
  scope: string
  sql: string
  /** SQL 代码块开了还没关（AI 正在写 SQL） */
  sqlOpen: boolean
  /** 「存为：」那一行（原文） */
  save: string | null
  /** AI 没按格式写（例如写成了 JSON）：界面直接显示原文 */
  unstructured: boolean
}

const MARK = /^[ \t]*(说明|范围|统计范围|存为)[ \t]*[：:][ \t]*/gm
const FENCE_OPEN = /```[ \t]*(sql|sqlite)?[ \t]*\r?\n/i
const MARK_WORDS = ['说明', '范围', '统计范围', '存为']

/** 末尾是一个还没写完的标记（例如「\n范」「\n统计」）：先去掉，免得闪一下 */
function dropPartialMark(s: string): string {
  const nl = s.lastIndexOf('\n')
  const last = s.slice(nl + 1).trim()
  if (!last) return s
  if (MARK_WORDS.some((w) => w.startsWith(last) || last === `${w}:` || last === `${w}：`)) return s.slice(0, nl + 1)
  return s
}

function sections(head: string): { explanation: string; scope: string } {
  const out: Record<string, string> = {}
  const marks = [...head.matchAll(MARK)]
  marks.forEach((m, i) => {
    const name = m[1] === '统计范围' ? '范围' : m[1]!
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < marks.length ? (marks[i + 1]!.index ?? head.length) : head.length
    if (!(name in out)) out[name] = head.slice(start, end).trim()
  })
  if (!marks.length && head.trim()) out['说明'] = head.trim()
  return { explanation: out['说明'] ?? '', scope: out['范围'] ?? '' }
}

export function parseAskDraft(text: string): AskDraft {
  const s = text ?? ''
  const t = s.trimStart()
  if (t.startsWith('{') || t.startsWith('```json')) {
    return { explanation: '', scope: '', sql: '', sqlOpen: false, save: null, unstructured: true }
  }
  let head = s
  let sql = ''
  let sqlOpen = false
  let tail = ''
  const open = FENCE_OPEN.exec(s)
  if (open) {
    head = s.slice(0, open.index)
    const bodyStart = open.index + open[0].length
    const close = s.indexOf('```', bodyStart)
    if (close >= 0) {
      sql = s.slice(bodyStart, close)
      tail = s.slice(close + 3)
    } else {
      sql = s.slice(bodyStart)
      sqlOpen = true
      // 代码块还没关：末尾可能是半个「```」
      sql = sql.replace(/`{1,2}$/, '')
    }
  } else {
    // 代码块的开头可能只写了一半（「``」「```sq」）：先不算进说明里
    head = head.replace(/`{1,3}[a-z]*$/i, '')
  }
  const { explanation, scope } = sections(dropPartialMark(head))
  let save: string | null = null
  const sm = /^[ \t]*存为[ \t]*[：:][ \t]*(.*)$/m.exec(tail)
  if (sm) save = sm[1]!.trim() || null
  return { explanation, scope, sql: sql.replace(/\s+$/, ''), sqlOpen, save, unstructured: false }
}
