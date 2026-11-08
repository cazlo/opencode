import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { contextPercent } from "@opencode/client/solid"
import {
  buildUsagePoints,
  buildUsageSeries,
  computeChartGeometry,
  DEFAULT_CHART_DIMENSIONS,
  type ChartCompactionCoord,
  type ChartDimensions,
  type ChartGeometry,
  type ChartPointCoord,
  type CompactionMarker,
  type UsagePoint,
  type UsageSeries,
} from "./usage-chart-model"

export {
  buildUsagePoints,
  buildUsageSeries,
  computeChartGeometry,
  DEFAULT_CHART_DIMENSIONS,
  type ChartCompactionCoord,
  type ChartDimensions,
  type ChartGeometry,
  type ChartPointCoord,
  type CompactionMarker,
  type UsagePoint,
  type UsageSeries,
}

export function SessionContextUsageChart(props: {
  messages: readonly SessionMessageInfo[]
  revertMessageID?: string
  limit?: number
  threshold?: number
  formatTokens: (value: number) => string
  formatPercent: (value: number) => string
  formatTime: (value: number | undefined) => string
  labels: {
    title: string
    empty: string
    header: (input: { step: number; time: string }) => string
    usage: (input: { tokens: string; ceiling?: string; percent?: string }) => string
    threshold: (input: { tokens: string; percent?: string }) => string
    compacted: (count: number) => string
    limit: (input: { tokens: string }) => string
  }
}) {
  const [hoveredIndex, setHoveredIndex] = createSignal<number | undefined>(undefined)
  const [chartWidth, setChartWidth] = createSignal(DEFAULT_CHART_DIMENSIONS.width)
  const fillID = `session-context-usage-fill-${createUniqueId()}`
  let chartContainer: HTMLDivElement | undefined

  createResizeObserver(
    () => chartContainer,
    ({ width }) => {
      if (width > 0) setChartWidth(Math.max(1, Math.round(width)))
    },
  )

  const series = createMemo(() => buildUsageSeries(props.messages, props.revertMessageID))

  const geometry = createMemo(() =>
    computeChartGeometry({
      series: series(),
      limit: props.limit,
      threshold: props.threshold,
      dimensions: {
        ...DEFAULT_CHART_DIMENSIONS,
        width: chartWidth(),
      },
    }),
  )

  const active = createMemo(() => {
    const pts = geometry().points
    const idx = hoveredIndex()

    if (idx !== undefined && pts[idx]) return pts[idx]
    const last = pts.at(-1)

    // A compaction after the last step emptied the context; show nothing until a new step reports usage, as the stats do.
    return last?.point.compactedAfter ? undefined : last
  })

  // Usage runs out at the compaction threshold, so the header measures against it rather than the context window.
  const ceiling = () => props.threshold ?? props.limit

  const activeUsagePercent = createMemo(() => {
    const current = active()

    return current ? contextPercent(current.point.total, ceiling()) : undefined
  })

  const thresholdSummary = createMemo(() => {
    const threshold = props.threshold

    if (!threshold || threshold <= 0) return undefined

    const pct = geometry().thresholdPercent

    return props.labels.threshold({
      tokens: props.formatTokens(threshold),
      percent: pct === undefined ? undefined : props.formatPercent(pct),
    })
  })

  const handlePointerMove = (event: PointerEvent & { currentTarget: SVGSVGElement }) => {
    const pts = geometry().points

    if (pts.length === 0) return

    const rect = event.currentTarget.getBoundingClientRect()

    if (rect.width <= 0) return

    const svgX = ((event.clientX - rect.left) / rect.width) * geometry().width

    let bestIndex = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let i = 0; i < pts.length; i++) {
      const distance = Math.abs(pts[i]!.x - svgX)

      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = i
      }
    }

    setHoveredIndex(bestIndex)
  }

  return (
    <div
      data-slot="session-usage-chart"
      class="flex flex-col gap-2 rounded-md border border-v2-border-border-base bg-surface-base p-3"
    >
      <div class="flex items-center justify-between gap-2 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-12-regular text-text-weak shrink-0">{props.labels.title}</span>
          <Show when={active()}>
            {(coord) => (
              <span class="text-12-regular text-text-weaker truncate">
                {props.labels.header({ step: coord().point.step, time: props.formatTime(coord().point.time) })}
              </span>
            )}
          </Show>
        </div>
        <div class="flex items-center gap-1.5 shrink-0 text-12-medium text-text-strong tabular-nums">
          <Show when={active()} fallback={<span class="text-text-weak">—</span>}>
            {(coord) => (
              <span>
                {props.labels.usage({
                  tokens: props.formatTokens(coord().point.total),
                  ceiling: ceiling() ? props.formatTokens(ceiling()!) : undefined,
                  percent:
                    ceiling() && activeUsagePercent() !== undefined
                      ? props.formatPercent(activeUsagePercent()!)
                      : undefined,
                })}
              </span>
            )}
          </Show>
        </div>
      </div>

      <div ref={chartContainer} class="relative w-full select-none">
        <svg
          viewBox={`0 0 ${geometry().width} ${geometry().height}`}
          preserveAspectRatio="none"
          class="w-full h-[92px] block overflow-visible touch-none"
          role="img"
          aria-label={props.labels.title}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoveredIndex(undefined)}
        >
          <defs>
            <linearGradient id={fillID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--text-interactive-base)" stop-opacity="0.22" />
              <stop offset="100%" stop-color="var(--text-interactive-base)" stop-opacity="0.02" />
            </linearGradient>
          </defs>

          <line
            x1={DEFAULT_CHART_DIMENSIONS.padX}
            y1={geometry().baselineY}
            x2={geometry().width - DEFAULT_CHART_DIMENSIONS.padX}
            y2={geometry().baselineY}
            stroke="var(--border-weak-base)"
            stroke-width="1"
          />

          <Show when={geometry().limitY}>
            {(y) => (
              <line
                x1={DEFAULT_CHART_DIMENSIONS.padX}
                y1={y()}
                x2={geometry().width - DEFAULT_CHART_DIMENSIONS.padX}
                y2={y()}
                stroke="var(--border-weak-base)"
                stroke-width="1"
              />
            )}
          </Show>

          <Show when={geometry().thresholdY}>
            {(y) => (
              <line
                data-slot="compaction-threshold-line"
                x1={DEFAULT_CHART_DIMENSIONS.padX}
                y1={y()}
                x2={geometry().width - DEFAULT_CHART_DIMENSIONS.padX}
                y2={y()}
                stroke="var(--icon-warning-base)"
                stroke-width="1.25"
                stroke-dasharray="4 3"
              />
            )}
          </Show>

          <For each={geometry().compactions}>
            {(compaction) => (
              <line
                data-slot="compaction-event-marker"
                x1={compaction.x}
                y1={DEFAULT_CHART_DIMENSIONS.padTop}
                x2={compaction.x}
                y2={geometry().baselineY}
                stroke="var(--icon-warning-base)"
                stroke-width="1.25"
                stroke-dasharray="3 2"
                stroke-opacity="0.75"
              />
            )}
          </For>

          <Show when={geometry().areaPath}>
            <path d={geometry().areaPath} fill={`url(#${fillID})`} />
          </Show>

          <Show when={geometry().linePath}>
            <path
              data-slot="context-usage-line"
              d={geometry().linePath}
              fill="none"
              stroke="var(--text-interactive-base)"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </Show>

          <Show when={active()}>
            {(coord) => (
              <line
                x1={coord().x}
                y1={DEFAULT_CHART_DIMENSIONS.padTop}
                x2={coord().x}
                y2={geometry().baselineY}
                stroke="var(--border-base)"
                stroke-width="1"
                stroke-dasharray="2 2"
              />
            )}
          </Show>

          <For each={geometry().points}>
            {(coord) => {
              const isSelected = () => active()?.point.id === coord.point.id

              return (
                <circle
                  cx={coord.x}
                  cy={coord.y}
                  r={isSelected() ? 3.5 : coord.point.compactedAfter ? 2.75 : 2}
                  fill={coord.point.compactedAfter ? "var(--icon-warning-base)" : "var(--text-interactive-base)"}
                  stroke="var(--background-base)"
                  stroke-width={isSelected() ? "1.5" : "1"}
                />
              )
            }}
          </For>
        </svg>

        <Show when={series().points.length === 0}>
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-12-regular text-text-weak">
            {props.labels.empty}
          </div>
        </Show>
      </div>

      <div class="flex items-center justify-between gap-2 text-12-regular text-text-weak tabular-nums">
        <div class="flex items-center gap-2 min-w-0 truncate">
          <Show when={thresholdSummary()}>
            {(summary) => (
              <span class="inline-flex items-center gap-1.5 truncate">
                <span
                  aria-hidden="true"
                  class="inline-block w-2.5 border-t border-dashed"
                  style={{ "border-color": "var(--icon-warning-base)" }}
                />
                <span class="truncate">{summary()}</span>
              </span>
            )}
          </Show>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <Show when={series().compactions.length > 0}>
            <span>{props.labels.compacted(series().compactions.length)}</span>
          </Show>
          <Show when={props.limit}>
            {(limit) => <span>{props.labels.limit({ tokens: props.formatTokens(limit()) })}</span>}
          </Show>
        </div>
      </div>
    </div>
  )
}
