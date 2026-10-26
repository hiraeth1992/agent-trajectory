import {
  Brain,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Coins,
  GitBranch,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type {
  TrajectoryStory as Story,
  TrajectoryStoryStage,
} from '../trajectory-story'
import { formatDuration, formatNumber } from '../trajectory-view-model'
import { HoverDetailText } from './HoverDetailText'

interface TrajectoryStoryProps {
  story: Story
  selectedStageId?: string
  onSelectStage: (stageId: string) => void
  onOpenStageDetails: (stageId: string) => void
}

function turnRange(stage: TrajectoryStoryStage): string {
  if (stage.turnStart === stage.turnEnd) {
    return stage.turnStart === 0 ? '会话级' : `第 ${stage.turnStart} 轮`
  }
  return `第 ${stage.turnStart}–${stage.turnEnd} 轮`
}

function reasonLevelLabel(stage: TrajectoryStoryStage): string {
  if (stage.rationaleLevel === 'fact') return '轨迹记录'
  if (stage.rationaleLevel === 'inferred') return '相邻步骤推断'
  return '来源未记录'
}

export function TrajectoryStory({
  story,
  selectedStageId,
  onSelectStage,
  onOpenStageDetails,
}: TrajectoryStoryProps) {
  const [playing, setPlaying] = useState(false)
  const selectedIndex = useMemo(
    () => Math.max(0, story.stages.findIndex(stage => stage.id === selectedStageId)),
    [selectedStageId, story.stages],
  )
  const selected = story.stages[selectedIndex]

  useEffect(() => {
    setPlaying(false)
  }, [story])

  useEffect(() => {
    if (!playing || story.stages.length < 2) return
    if (selectedIndex >= story.stages.length - 1) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => {
      const next = story.stages[selectedIndex + 1]
      if (next !== undefined) onSelectStage(next.id)
    }, 1_400)
    return () => window.clearTimeout(timer)
  }, [onSelectStage, playing, selectedIndex, story.stages])

  const move = (offset: -1 | 1) => {
    const next = story.stages[selectedIndex + offset]
    if (next === undefined) return
    setPlaying(false)
    onSelectStage(next.id)
  }

  const togglePlaying = () => {
    if (story.stages.length < 2) return
    if (!playing && selectedIndex === story.stages.length - 1) {
      onSelectStage(story.stages[0]!.id)
    }
    setPlaying(current => !current)
  }

  const select = (stageId: string) => {
    setPlaying(false)
    onSelectStage(stageId)
  }

  const openDetails = (stageId: string) => {
    setPlaying(false)
    onSelectStage(stageId)
    onOpenStageDetails(stageId)
  }

  const handleStageKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    stageId: string,
    active: boolean,
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (active) openDetails(stageId)
    else select(stageId)
  }

  const selection = selected === undefined
    ? null
    : (
        <div className="story-selection story-selection-triad" aria-live="polite">
          <StoryTriadItem
            icon={<Brain size={14} />}
            label="模型判断"
            value={selected.judgment}
            meta={reasonLevelLabel(selected)}
            className="judgment"
          />
          <StoryTriadItem
            icon={<GitBranch size={14} />}
            label="关键行动"
            value={selected.actions.join('；')}
            meta={`${turnRange(selected)} · ${selected.stepCount} 步`}
            className="actions"
          />
          <StoryTriadItem
            icon={selected.errorCount > 0
              ? <RotateCcw size={14} />
              : <CheckCircle2 size={14} />}
            label="阶段结果"
            value={selected.outcome}
            meta={selected.errorCount > 0
              ? `${selected.errorCount} 异常 · ${selected.recoveredCount} 已恢复`
              : '已完成'}
            className="outcome"
          />
          <StoryFacts stage={selected} />
        </div>
      )

  return (
    <section
      className="summary-panel trajectory-story-panel"
      aria-label="执行故事线"
    >
      <header className="summary-panel-heading trajectory-story-heading">
        <div>
          <GitBranch size={17} />
          <span>
            <strong>执行故事线</strong>
            <small>
              {story.stages.length === 0
                ? '没有可归纳的逻辑步骤'
                : `${story.stages.length} 个阶段 · 单击查看聚合结论，双击展开下方明细`}
            </small>
          </span>
        </div>
        {story.stages.length > 0 && (
          <div className="story-controls" aria-label="故事线播放控制">
            <button
              type="button"
              disabled={selectedIndex === 0}
              onClick={() => move(-1)}
            >
              上一步
            </button>
            <button
              type="button"
              className="story-play"
              aria-pressed={playing}
              onClick={togglePlaying}
            >
              {playing ? <Pause size={12} /> : <Play size={12} />}
              {playing ? '暂停' : '播放'}
            </button>
            <span>{selectedIndex + 1} / {story.stages.length}</span>
            <button
              type="button"
              disabled={selectedIndex === story.stages.length - 1}
              onClick={() => move(1)}
            >
              下一步
            </button>
          </div>
        )}
      </header>

      {story.stages.length === 0
        ? <div className="summary-empty">当前会话没有可生成故事线的逻辑步骤</div>
        : (
            <>
              <div
                className="story-track"
                style={{
                  '--story-progress': story.stages.length === 1
                    ? 1
                    : selectedIndex / (story.stages.length - 1),
                  '--story-count': story.stages.length,
                } as CSSProperties}
              >
                <i className="story-track-line" aria-hidden="true" />
                <i className="story-track-progress" aria-hidden="true" />
                <div className="story-nodes" role="list" aria-label="执行阶段">
                  {story.stages.map((stage, index) => {
                    const active = stage.id === selected?.id
                    const completed = index < selectedIndex
                    return (
                      <button
                        type="button"
                        className={[
                          'story-node',
                          `phase-${stage.phase}`,
                          active ? 'active' : '',
                          completed ? 'completed' : '',
                          stage.errorCount > 0 ? 'has-error' : '',
                        ].filter(Boolean).join(' ')}
                        aria-current={active ? 'step' : undefined}
                        aria-label={`${stage.title}，${turnRange(stage)}，${stage.stepCount} 步`}
                        title="单击查看聚合结论，双击展开阶段明细"
                        key={stage.id}
                        onClick={() => select(stage.id)}
                        onDoubleClick={() => openDetails(stage.id)}
                        onKeyDown={event =>
                          handleStageKeyDown(event, stage.id, active)}
                      >
                        <span className="story-node-dot">
                          {stage.errorCount > 0
                            ? <CircleAlert size={13} />
                            : index === story.stages.length - 1
                              ? <CheckCircle2 size={13} />
                              : <span>{index + 1}</span>}
                        </span>
                        <strong>{stage.title}</strong>
                        <small>
                          {turnRange(stage)} · {stage.stepCount} 步
                        </small>
                        {stage.errorCount > 0 && (
                          <em>{stage.errorCount} 异常</em>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>

              {selection}
            </>
          )}
    </section>
  )
}

function StoryFacts({ stage }: { stage: TrajectoryStoryStage }) {
  return (
    <div className="story-selection-facts">
      <span><Clock3 size={12} />{formatDuration(stage.durationMs)}</span>
      <span>
        <Coins size={12} />
        {formatNumber(stage.usage?.totalTokens)} Token
      </span>
    </div>
  )
}

function StoryTriadItem({
  icon,
  label,
  value,
  meta,
  className,
}: {
  icon: ReactNode
  label: string
  value: string
  meta: string
  className: string
}) {
  return (
    <section className={`story-triad-item ${className}`}>
      <header>{icon}<strong>{label}</strong><em>{meta}</em></header>
      <p>
        <HoverDetailText
          className="summary-hover-detail story-summary-detail"
          text={value}
        />
      </p>
    </section>
  )
}
