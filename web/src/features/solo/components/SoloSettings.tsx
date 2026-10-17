/**
 * 设置（右上角「设置」弹出面板）。存浏览器；标签数、时间限制、分界秒数、从作品里选的加时下一局生效；新角色保底改了会重建会话。
 * 界面大小马上生效（只放大页头下面的内容区）。
 * 放在弹出面板里，平时不占地方。
 */
import { useId, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { SegmentedControl, Switch, SwitchRow } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Overlay'
import { IconRotate, IconSliders } from '@/lib/icons'
import {
  clampAutoStay,
  clampGoodSec,
  clampInt,
  clampTimeLimit,
  clampUiScale,
  clampWorkBonus,
  LIMITS,
  UI_SCALES,
  useSoloSettings,
  type PlayMode,
} from '../settings'

const SCALE_OPTIONS = UI_SCALES.map((x) => ({ value: String(x), label: `${Math.round(x * 100)}%` }))

function Row({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm text-fg-1">
          {label}
        </label>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
      {hint && <p className="text-xs text-fg-3">{hint}</p>}
    </div>
  )
}

export function SoloSettingsButton({ sessionDefaultTagNum }: { sessionDefaultTagNum: number | null }) {
  const s = useSoloSettings()
  const id = useId()
  const follow = s.subjectTagNum === 'follow'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" icon={<IconSliders />}>
          设置
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[80dvh] w-96 flex-col gap-4 overflow-y-auto">
        <Row label="界面大小" hint="放大搜索框、表格和结算卡片；左侧栏和最上面一行不变">
          <SegmentedControl
            size="sm"
            value={String(clampUiScale(s.uiScale))}
            onChange={(v) => s.set({ uiScale: clampUiScale(Number(v)) })}
            options={SCALE_OPTIONS}
            aria-label="界面大小"
          />
        </Row>
        <Row label="结算方式" hint={s.playMode === 'manual' ? '每局结束看卡片、自己选评级，Enter 开下一局' : '每局结束短暂显示卡片后直接开下一局；右上角可以改上一局的评级'}>
          <SegmentedControl<PlayMode>
            size="sm"
            value={s.playMode}
            onChange={(v) => s.set({ playMode: v })}
            options={[
              { value: 'manual', label: '手动' },
              { value: 'auto', label: '自动' },
            ]}
            aria-label="结算方式"
          />
        </Row>
        {s.playMode === 'auto' && (
          <Row label="卡片停留" htmlFor={`${id}-stay`}>
            <NumberField
              id={`${id}-stay`}
              size="sm"
              className="w-24"
              value={s.autoStaySec}
              min={LIMITS.autoStay.min}
              max={LIMITS.autoStay.max}
              step={0.5}
              suffix="秒"
              onCommit={(v) => v != null && s.set({ autoStaySec: clampAutoStay(v) })}
            />
          </Row>
        )}

        <div className="h-px bg-border" />
        <p className="-mb-2 text-xs text-fg-3">下面五项这一局中途改了，下一局生效</p>

        <Row label="时间限制" htmlFor={`${id}-limit`} hint="留空 = 不限时。到时间算一次没猜中，表格加一行「超时」">
          <NumberField
            id={`${id}-limit`}
            size="sm"
            className="w-24"
            value={s.timeLimitSec}
            min={LIMITS.timeLimit.min}
            max={LIMITS.timeLimit.max}
            integer
            allowEmpty
            placeholder="不限时"
            suffix="秒"
            onCommit={(v) => s.set({ timeLimitSec: clampTimeLimit(v) })}
          />
        </Row>
        <Row label="作品标签数" htmlFor={`${id}-stag`} hint={follow ? `跟随方案：现在是 ${sessionDefaultTagNum ?? '…'} 个` : '不跟随方案，固定用这个数'}>
          <span className="flex items-center gap-1.5 text-xs text-fg-3">
            跟随方案
            <Switch
              size="sm"
              checked={follow}
              onChange={(v) => s.set({ subjectTagNum: v ? 'follow' : clampInt(sessionDefaultTagNum ?? 6, 0, 10) })}
              aria-label="作品标签数跟随方案"
            />
          </span>
          {!follow && (
            <NumberField
              id={`${id}-stag`}
              size="sm"
              className="w-20"
              value={typeof s.subjectTagNum === 'number' ? s.subjectTagNum : null}
              min={LIMITS.tagNum.min}
              max={LIMITS.tagNum.max}
              integer
              onCommit={(v) => v != null && s.set({ subjectTagNum: clampInt(v, 0, 10) })}
            />
          )}
        </Row>
        <Row label="角色标签数" htmlFor={`${id}-ctag`}>
          <NumberField
            id={`${id}-ctag`}
            size="sm"
            className="w-20"
            value={s.characterTagNum}
            min={LIMITS.tagNum.min}
            max={LIMITS.tagNum.max}
            integer
            onCommit={(v) => v != null && s.set({ characterTagNum: clampInt(v, 0, 10) })}
          />
        </Row>
        <Row label="Good / Hard 分界" htmlFor={`${id}-good`} hint="第 3 次及以后才猜中时，按第 2→3、3→4… 次的平均间隔算：不超过它 = Good，超过 = Hard">
          <NumberField
            id={`${id}-good`}
            size="sm"
            className="w-24"
            value={s.goodSec}
            min={LIMITS.goodSec.min}
            max={LIMITS.goodSec.max}
            step={0.5}
            suffix="秒"
            onCommit={(v) => v != null && s.set({ goodSec: clampGoodSec(v) })}
          />
        </Row>
        <Row label="从作品里选时多给几秒" htmlFor={`${id}-bonus`} hint="这一次猜测是从作品的角色列表里选的，Good / Hard 的分界线多给这么多秒">
          <NumberField
            id={`${id}-bonus`}
            size="sm"
            className="w-24"
            value={s.workBonusSec}
            min={LIMITS.workBonus.min}
            max={LIMITS.workBonus.max}
            step={LIMITS.workBonus.step}
            suffix="秒"
            onCommit={(v) => v != null && s.set({ workBonusSec: clampWorkBonus(v) })}
          />
        </Row>

        <div className="h-px bg-border" />

        <Row label="新角色保底" htmlFor={`${id}-new`} hint="每 N 局至少出 1 个新角色；0 = 不保底。改了会重新开始（这一局作废）">
          <NumberField
            id={`${id}-new`}
            size="sm"
            className="w-24"
            value={s.newEvery}
            min={LIMITS.newEvery.min}
            max={LIMITS.newEvery.max}
            integer
            suffix="局"
            onCommit={(v) => v != null && s.set({ newEvery: clampInt(v, LIMITS.newEvery.min, LIMITS.newEvery.max) })}
          />
        </Row>
        <SwitchRow
          label="搜 Bangumi 全库"
          description="在线搜，能搜到别名；要能连上 Bangumi，可能比较慢。关着 = 搜本地全库"
          checked={s.bgmSearch}
          onChange={(v) => s.set({ bgmSearch: v })}
        />

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" icon={<IconRotate />} onClick={() => s.reset()}>
            恢复默认
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
