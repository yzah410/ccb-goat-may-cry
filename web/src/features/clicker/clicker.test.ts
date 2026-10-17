import { describe, expect, it } from 'vitest'
import { STATE_LABEL, STATE_TONE, logsSince, markLogs, normalizeStatus, taskOutcome } from './normalize'

describe('点击器状态：完整结构（backend/clicker/models.py）', () => {
  const now = Date.now() / 1000
  const full = {
    connected: true,
    browser_ok: true,
    cdp_port: 9223,
    page_url: 'http://localhost:5173/multiplayer/x',
    page_role: 'host',
    state: 'done',
    busy: false,
    task_id: 'task-1',
    target: { char_id: 1, name: 'レイ', name_cn: '雷伊', work_hint: null },
    last_error: null,
    last_result: { ok: true, summary: '搜「レイ 雷伊」第 3 项', nth: 3 },
    logs: [
      { ts: now - 5, level: 'info', msg: '收到任务 task-1' },
      { ts: now - 1, level: 'info', msg: '出题成功，本局已开始 ✅' },
    ],
    auto: { running: false, mode: null, round: 0, failed: 0 },
    running: false,
    manual_running: false,
    auto_running: false,
    log_lines: ['..'],
  }
  it('规整成统一形态（日志对象 → 毫秒时间戳；✅ 标成 success）', () => {
    const v = normalizeStatus(full)
    expect(v.connected).toBe(true)
    expect(v.pageRole).toBe('host')
    expect(v.target?.name_cn).toBe('雷伊')
    expect(v.logs[1]!.level).toBe('success')
    expect(v.logs[1]!.ts).toBeGreaterThan(1e12)
  })
  it('完整结构按 state / last_result 判断结果', () => {
    const v = normalizeStatus(full)
    expect(taskOutcome(v, [])).toEqual({ ok: true, message: '搜「レイ 雷伊」第 3 项' })
    const failed = normalizeStatus({ ...full, state: 'error', last_error: '出题弹窗没开' })
    expect(taskOutcome(failed, [])).toEqual({ ok: false, message: '出题弹窗没开' })
  })
  it('任务还在跑时不下结论', () => {
    expect(taskOutcome(normalizeStatus({ ...full, busy: true }), [])).toBeNull()
  })
  it('取消中 / 取消卡住 / 后端关闭 这 3 个 state：规整不报错，有标签、有颜色', () => {
    const tone = { cancelling: 'warning', stuck: 'danger', closed: 'neutral' } as const
    for (const [state, busy] of [
      ['cancelling', true],
      ['stuck', true],
      ['closed', false],
    ] as const) {
      const v = normalizeStatus({ ...full, state, busy })
      expect(v.state).toBe(state)
      expect(v.busy).toBe(busy)
      expect(STATE_LABEL[state], state).toBeTruthy()
      expect(STATE_TONE[state], state).toBe(tone[state])
    }
    // 取消中 / 卡住时 busy 还是 true：不下结论，继续等任务真正停下
    expect(taskOutcome(normalizeStatus({ ...full, state: 'cancelling', busy: true }), [])).toBeNull()
    expect(taskOutcome(normalizeStatus({ ...full, state: 'stuck', busy: true }), [])).toBeNull()
    // 后端关闭：算失败（不会因为日志最后一行是普通信息就被当成成功）
    expect(taskOutcome(normalizeStatus({ ...full, state: 'closed', busy: false, last_error: null, last_result: null }), [])).toEqual({
      ok: false,
      message: '点击器已关闭（后端正在退出）',
    })
    expect(taskOutcome(normalizeStatus({ ...full, state: 'closed', busy: false, last_error: '服务关闭，任务被中止' }), [])).toEqual({
      ok: false,
      message: '服务关闭，任务被中止',
    })
  })
  it('每个已知 state 都有标签和颜色', () => {
    for (const s of ['idle', 'locating', 'typing', 'selecting', 'confirming', 'done', 'error', 'cancelling', 'stuck', 'closed']) {
      expect(STATE_LABEL[s], s).toBeTruthy()
      expect(STATE_TONE[s], s).toBeTruthy()
    }
  })
})

describe('点击器状态：日志窗口和缺字段', () => {
  it('按发送时间找出这次任务新产生的日志，并在 state 没结论时看日志文字', () => {
    const m = markLogs()
    const t = m.sentAt / 1000
    const v = normalizeStatus({
      state: 'idle',
      busy: false,
      logs: [
        { ts: t - 60, level: 'info', msg: '上一个任务' },
        { ts: t + 0.5, level: 'info', msg: '收到任务' },
        { ts: t + 1, level: 'error', msg: '执行失败：未检测到出题弹窗' },
      ],
    })
    const fresh = logsSince(v, m)
    expect(fresh.map((l) => l.msg)).toEqual(['收到任务', '执行失败：未检测到出题弹窗'])
    expect(taskOutcome(v, fresh)).toEqual({ ok: false, message: '执行失败：未检测到出题弹窗' })
  })
  it('完全缺字段也不报错', () => {
    const v = normalizeStatus(null)
    expect(v.logs).toEqual([])
    expect(v.busy).toBe(false)
    expect(v.autoRunning).toBe(false)
    expect(v.pageUrl).toBeNull()
  })
})
