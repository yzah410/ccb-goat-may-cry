/**
 * ① 对局设置：模式 + 作品标签数。它不决定「出谁」，决定的是每个角色在游戏格子里显示成什么样
 * （作品标签、登场数、最早 / 最晚年……），所以必须和房间的设置一致。
 */
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/Controls'
import { NumberField } from '@/components/ui/NumberField'
import { toast } from '@/components/ui/Toast'
import { IconGamepad, IconInfo, IconMinus, IconPlus } from '@/lib/icons'
import type { ModeId } from '@/features/v2/types'
import { MODES, MODE_BY_ID, TAG_COUNT_MAX, TAG_COUNT_MIN, switchMode } from '../spec'
import { useWb2 } from '../store'

export function GameSettingsCard() {
  const game = useWb2((s) => s.spec.game)
  const edit = useWb2((s) => s.edit)
  const undo = useWb2((s) => s.undo)

  const setMode = (mode: ModeId) => {
    if (mode === game.mode) return
    const { spec, moved } = switchMode(useWb2.getState().spec, mode)
    edit(`换成${MODE_BY_ID.get(mode)?.label}模式`, () => spec)
    if (moved.length)
      toast.info(`${moved.join('、')}也改成从${MODE_BY_ID.get(mode)?.label}里取作品`, {
        id: 'mode-switch',
        description: '和猜猜呗一样：分类同时决定从哪出题、格子怎么算',
        action: { label: '撤销', onClick: undo },
      })
  }
  const setTagCount = (n: number, coalesce = true) =>
    edit('改作品标签数', (s) => ({ ...s, game: { ...s.game, tag_count: n } }), coalesce ? { coalesce: 'tag_count' } : undefined)

  return (
    <Card className="@container p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-fg-2 [&_svg]:size-4">
              <IconGamepad aria-hidden />
            </span>
            <h2 className="text-base text-fg-1">对局设置</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-fg-2">模式</span>
            <SegmentedControl<ModeId> size="sm" value={game.mode} onChange={setMode} aria-label="模式" options={MODES.map((m) => ({ value: m.id, label: m.label }))} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-2">作品标签数</span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="少一个"
              disabled={game.tag_count <= TAG_COUNT_MIN}
              onClick={() => setTagCount(game.tag_count - 1)}
            >
              <IconMinus />
            </Button>
            <NumberField
              value={game.tag_count}
              onCommit={(v) => v !== null && setTagCount(v)}
              integer
              min={TAG_COUNT_MIN}
              max={TAG_COUNT_MAX}
              fallback={game.tag_count}
              size="sm"
              className="w-12 text-center"
              aria-label="作品标签数（0–10）"
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="多一个"
              disabled={game.tag_count >= TAG_COUNT_MAX}
              onClick={() => setTagCount(game.tag_count + 1)}
            >
              <IconPlus />
            </Button>
            <span className="text-xs text-fg-3">0–10，默认 6</span>
          </div>
        </div>
        <p className="flex items-start gap-1.5 text-xs text-fg-2">
          <IconInfo className="mt-px size-3.5 shrink-0 text-info" aria-hidden />
          要和你们房间的设置一致，否则筛出来的角色在游戏里对不上：它决定每个角色在游戏格子里显示哪些作品标签、登场数、最早 / 最晚年。
        </p>
      </div>
    </Card>
  )
}
