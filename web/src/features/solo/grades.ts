/**
 * 评级（Easy / Good / Hard / Again）：显示用的文字、←/→ 切换、Alt+1–4。
 * 自动评级由后端算（永远不给 Easy）；前端只负责让用户改。
 */
import { GRADES, type Grade } from './api'

export const GRADE_LABEL: Record<Grade, string> = { easy: 'Easy', good: 'Good', hard: 'Hard', again: 'Again' }

/** 每个评级一句话（鼠标移上去看） */
export const GRADE_HINT: Record<Grade, string> = {
  easy: '很熟，下次隔得更久再出（只能手动选）',
  good: '记得：第 1、2 次就猜中，或者后面每次间隔不超过分界秒数',
  hard: '记起来了，但想得慢：平均间隔超过分界秒数',
  again: '没记住：错满次数或者投降，很快再出',
}

/** ←/→ 切换：到头停住，不循环 */
export function stepGrade(g: Grade, dir: -1 | 1): Grade {
  const i = GRADES.indexOf(g)
  const j = Math.min(GRADES.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))
  return GRADES[j]!
}

/** Alt+1/2/3/4 → Easy/Good/Hard/Again；别的数字 → null */
export function gradeFromDigit(d: string | number): Grade | null {
  const n = typeof d === 'number' ? d : Number.parseInt(d, 10)
  return Number.isInteger(n) && n >= 1 && n <= 4 ? GRADES[n - 1]! : null
}

/** 选的评级和后端记的不一样，才需要调 regrade */
export function needsRegrade(chosen: Grade, recorded: Grade): boolean {
  return chosen !== recorded
}
