import type { SessionMessageInfo } from "@opencode/client/promise"
import { contextTokens } from "@opencode/client/solid"

export type UsagePoint = {
  readonly id: string
  readonly step: number
  readonly time: number
  readonly total: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly compactedAfter: boolean
}

export type CompactionMarker = {
  readonly id: string
  readonly time: number
  readonly afterPointIndex: number
  readonly reason: "auto" | "manual"
}

export type UsageSeries = {
  readonly points: readonly UsagePoint[]
  readonly compactions: readonly CompactionMarker[]
  readonly maxTokens: number
  readonly latest: UsagePoint | undefined
}

export type ChartDimensions = {
  readonly width: number
  readonly height: number
  readonly padX: number
  readonly padTop: number
  readonly padBottom: number
}

export type ChartPointCoord = {
  readonly point: UsagePoint
  readonly index: number
  readonly x: number
  readonly y: number
}

export type ChartCompactionCoord = {
  readonly marker: CompactionMarker
  readonly x: number
}

export type ChartGeometry = {
  readonly width: number
  readonly height: number
  readonly baselineY: number
  readonly domainMax: number
  readonly thresholdY: number | undefined
  readonly thresholdPercent: number | undefined
  readonly limitY: number | undefined
  readonly points: readonly ChartPointCoord[]
  readonly compactions: readonly ChartCompactionCoord[]
  readonly linePath: string
  readonly areaPath: string
}

export const DEFAULT_CHART_DIMENSIONS: ChartDimensions = {
  width: 360,
  height: 92,
  padX: 6,
  padTop: 8,
  padBottom: 8,
}

export function buildUsageSeries(messages: readonly SessionMessageInfo[], revertMessageID?: string): UsageSeries {
  const boundaryIndex = revertMessageID ? messages.findIndex((message) => message.id === revertMessageID) : -1

  if (revertMessageID && boundaryIndex === -1) {
    return {
      points: [],
      compactions: [],
      maxTokens: 0,
      latest: undefined,
    }
  }

  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const points: UsagePoint[] = []
  const compactions: CompactionMarker[] = []

  for (let index = 0; index < end; index++) {
    const message = messages[index]

    if (!message) continue

    if (message.type === "assistant" && message.tokens !== undefined) {
      const tokens = message.tokens

      const total = contextTokens(tokens)

      // A failed or aborted step reports zero usage; plotting it would look like an unmarked compaction.
      if (total <= 0) continue

      points.push({
        id: message.id,
        step: points.length + 1,
        time: message.time.completed ?? message.time.created,
        total,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
        compactedAfter: false,
      })

      continue
    }

    if (message.type === "compaction" && message.status === "completed") {
      const previousIndex = points.length - 1
      const previous = previousIndex >= 0 ? points[previousIndex] : undefined

      if (previous && !previous.compactedAfter) {
        points[previousIndex] = {
          ...previous,
          compactedAfter: true,
        }
      }

      compactions.push({
        id: message.id,
        time: message.time.created,
        afterPointIndex: previousIndex,
        reason: message.reason,
      })
    }
  }

  const maxTokens = points.reduce((max, point) => (point.total > max ? point.total : max), 0)

  return {
    points,
    compactions,
    maxTokens,
    latest: points.at(-1),
  }
}

export function buildUsagePoints(
  messages: readonly SessionMessageInfo[],
  revertMessageID?: string,
): readonly UsagePoint[] {
  return buildUsageSeries(messages, revertMessageID).points
}

export function computeChartGeometry(input: {
  readonly series: UsageSeries
  readonly limit?: number
  readonly threshold?: number
  readonly dimensions?: ChartDimensions
}): ChartGeometry {
  const dims = input.dimensions ?? DEFAULT_CHART_DIMENSIONS
  const plotWidth = Math.max(1, dims.width - dims.padX * 2)
  const plotHeight = Math.max(1, dims.height - dims.padTop - dims.padBottom)
  const baselineY = dims.padTop + plotHeight

  const ceiling = input.threshold && input.threshold > 0 ? input.threshold : (input.limit ?? 0)

  const domainMax = Math.max(ceiling, input.series.maxTokens, 1)

  const toY = (tokens: number) => {
    const ratio = Math.min(1, Math.max(0, tokens / domainMax))

    return Number((dims.padTop + plotHeight * (1 - ratio)).toFixed(2))
  }

  const count = input.series.points.length

  const toX = (index: number) => {
    if (count <= 1) return Number((dims.padX + plotWidth / 2).toFixed(2))

    return Number((dims.padX + (index / (count - 1)) * plotWidth).toFixed(2))
  }

  const points: ChartPointCoord[] = input.series.points.map((point, index) => ({
    point,
    index,
    x: toX(index),
    y: toY(point.total),
  }))

  const compactions: ChartCompactionCoord[] = input.series.compactions.map((marker) => {
    const left = marker.afterPointIndex >= 0 ? points[marker.afterPointIndex] : undefined
    const right = marker.afterPointIndex + 1 < points.length ? points[marker.afterPointIndex + 1] : undefined

    if (left && right) {
      return {
        marker,
        x: Number(((left.x + right.x) / 2).toFixed(2)),
      }
    }

    if (left) {
      return {
        marker,
        x: Number(Math.min(dims.padX + plotWidth, left.x + 10).toFixed(2)),
      }
    }

    return {
      marker,
      x: dims.padX,
    }
  })

  const thresholdY = input.threshold !== undefined && input.threshold > 0 ? toY(input.threshold) : undefined

  const thresholdPercent =
    input.threshold !== undefined && input.limit && input.limit > 0
      ? Math.round((input.threshold / input.limit) * 100)
      : undefined

  const limitY =
    input.threshold === undefined && input.limit !== undefined && input.limit > 0 ? toY(input.limit) : undefined

  const linePath = buildLinePath(points, dims.padX)
  const areaPath = buildAreaPath(points, dims.padX, baselineY)

  return {
    width: dims.width,
    height: dims.height,
    baselineY,
    domainMax,
    thresholdY,
    thresholdPercent,
    limitY,
    points,
    compactions,
    linePath,
    areaPath,
  }
}

function buildLinePath(points: readonly ChartPointCoord[], padX: number): string {
  if (points.length === 0) return ""

  if (points.length === 1) {
    const only = points[0]!

    return `M ${padX} ${only.y} L ${only.x} ${only.y}`
  }

  return points.map((coord, index) => `${index === 0 ? "M" : "L"} ${coord.x} ${coord.y}`).join(" ")
}

function buildAreaPath(points: readonly ChartPointCoord[], padX: number, baselineY: number): string {
  if (points.length === 0) return ""

  if (points.length === 1) {
    const only = points[0]!

    return `M ${padX} ${baselineY} L ${padX} ${only.y} L ${only.x} ${only.y} L ${only.x} ${baselineY} Z`
  }

  const first = points[0]!
  const last = points.at(-1)!
  const middle = points.map((coord) => `L ${coord.x} ${coord.y}`).join(" ")

  return `M ${first.x} ${baselineY} ${middle} L ${last.x} ${baselineY} Z`
}
