import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { createSessionContextFormatter, formatSessionDuration } from "./format"
import { buildUsagePoints, buildUsageSeries, computeChartGeometry } from "./usage-chart-model"

function assistantMsg(
  id: string,
  time: { created: number; completed?: number },
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  },
): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    time,
    agent: "build",
    model: { id: "claude-opus-4-6", providerID: "anthropic" },
    content: [],
    tokens,
  }
}

function userMsg(id: string, created: number): SessionMessageInfo {
  return {
    id,
    type: "user",
    time: { created },
    text: "hello",
  }
}

function compactionMsg(
  id: string,
  created: number,
  status: "running" | "completed" | "failed" = "completed",
): SessionMessageInfo {
  if (status === "running") {
    return {
      id,
      type: "compaction",
      time: { created },
      status: "running",
      reason: "auto",
      summary: "",
    }
  }

  if (status === "failed") {
    return {
      id,
      type: "compaction",
      time: { created },
      status: "failed",
      reason: "auto",
      error: { type: "compaction.failed", message: "failed" },
    }
  }

  return {
    id,
    type: "compaction",
    time: { created },
    status: "completed",
    reason: "auto",
    summary: "checkpoint",
  }
}

describe("compactTokens", () => {
  test("formats token counts compactly for the locale", () => {
    const fmt = createSessionContextFormatter("en-US")

    expect(fmt.compactTokens(0)).toBe("0")
    expect(fmt.compactTokens(512)).toBe("512")
    expect(fmt.compactTokens(16_000)).toBe("16K")
    expect(fmt.compactTokens(892_500)).toBe("892.5K")
    expect(fmt.compactTokens(1_050_000)).toBe("1.05M")
  })
})

describe("buildUsageSeries", () => {
  test("skips steps that report zero usage", () => {
    const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const used = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }

    const series = buildUsageSeries([
      assistantMsg("a1", { created: 1, completed: 2 }, used),
      assistantMsg("a-failed", { created: 3, completed: 4 }, zero),
      assistantMsg("a2", { created: 5, completed: 6 }, used),
    ])

    expect(series.points.map((point) => [point.id, point.step])).toEqual([
      ["a1", 1],
      ["a2", 2],
    ])
  })

  test("extracts assistant token points and marks completed compactions", () => {
    const messages: SessionMessageInfo[] = [
      userMsg("u1", 1000),
      assistantMsg(
        "a1",
        { created: 1100, completed: 1200 },
        {
          input: 10_000,
          output: 2_000,
          reasoning: 500,
          cache: { read: 80_000, write: 5_000 },
        },
      ),
      assistantMsg("a-streaming", { created: 1500 }),
      compactionMsg("c-failed", 1600, "failed"),
      assistantMsg(
        "a2",
        { created: 2000, completed: 2100 },
        {
          input: 20_000,
          output: 3_000,
          reasoning: 1_000,
          cache: { read: 150_000, write: 10_000 },
        },
      ),
      compactionMsg("c1", 2500, "completed"),
      assistantMsg(
        "a3",
        { created: 3000 },
        {
          input: 5_000,
          output: 1_000,
          reasoning: 0,
          cache: { read: 20_000, write: 2_000 },
        },
      ),
    ]

    const series = buildUsageSeries(messages)

    expect(series.points).toHaveLength(3)
    expect(series.points[0]).toEqual({
      id: "a1",
      step: 1,
      time: 1200,
      total: 97_500,
      input: 10_000,
      output: 2_000,
      reasoning: 500,
      cacheRead: 80_000,
      cacheWrite: 5_000,
      compactedAfter: false,
    })
    expect(series.points[1]?.compactedAfter).toBe(true)
    expect(series.points[1]?.total).toBe(184_000)
    expect(series.points[2]?.compactedAfter).toBe(false)
    expect(series.points[2]?.total).toBe(28_000)
    expect(series.maxTokens).toBe(184_000)
    expect(series.latest?.id).toBe("a3")
    expect(series.compactions).toEqual([
      {
        id: "c1",
        time: 2500,
        afterPointIndex: 1,
        reason: "auto",
      },
    ])
  })

  test("respects revertMessageID boundary", () => {
    const messages: SessionMessageInfo[] = [
      assistantMsg(
        "a1",
        { created: 1000 },
        {
          input: 1000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
      userMsg("u2", 2000),
      assistantMsg(
        "a2",
        { created: 3000 },
        {
          input: 4000,
          output: 500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
    ]

    expect(buildUsagePoints(messages, "u2").map((point) => point.id)).toEqual(["a1"])
    expect(buildUsagePoints(messages, "missing-id")).toEqual([])
  })

  test("preserves full history across multiple compactions", () => {
    const messages: SessionMessageInfo[] = [
      userMsg("u1", 1000),
      assistantMsg(
        "a1",
        { created: 1100 },
        {
          input: 80_000,
          output: 2_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
      assistantMsg(
        "a2",
        { created: 1200 },
        {
          input: 165_000,
          output: 3_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
      compactionMsg("c1", 1300, "completed"),
      assistantMsg(
        "a3",
        { created: 1400 },
        {
          input: 35_000,
          output: 2_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
      assistantMsg(
        "a4",
        { created: 1500 },
        {
          input: 168_000,
          output: 4_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
      compactionMsg("c2", 1600, "completed"),
      assistantMsg(
        "a5",
        { created: 1700 },
        {
          input: 42_000,
          output: 1_500,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
    ]

    const series = buildUsageSeries(messages)

    expect(
      series.points.map((point) => ({ id: point.id, step: point.step, compactedAfter: point.compactedAfter })),
    ).toEqual([
      { id: "a1", step: 1, compactedAfter: false },
      { id: "a2", step: 2, compactedAfter: true },
      { id: "a3", step: 3, compactedAfter: false },
      { id: "a4", step: 4, compactedAfter: true },
      { id: "a5", step: 5, compactedAfter: false },
    ])
    expect(series.compactions.map((item) => ({ id: item.id, afterPointIndex: item.afterPointIndex }))).toEqual([
      { id: "c1", afterPointIndex: 1 },
      { id: "c2", afterPointIndex: 3 },
    ])
  })
})

describe("computeChartGeometry", () => {
  test("computes coordinates, paths, and threshold line for multi-step session", () => {
    const series = buildUsageSeries([
      assistantMsg(
        "a1",
        { created: 1000 },
        {
          input: 100_000,
          output: 5_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
      compactionMsg("c1", 1500, "completed"),
      assistantMsg(
        "a2",
        { created: 2000 },
        {
          input: 40_000,
          output: 2_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      ),
    ])

    const geometry = computeChartGeometry({
      series,
      limit: 200_000,
      threshold: 170_000,
      dimensions: { width: 200, height: 100, padX: 10, padTop: 10, padBottom: 10 },
    })

    expect(geometry.domainMax).toBe(170_000)
    expect(geometry.thresholdPercent).toBe(85)
    expect(geometry.thresholdY).toBe(10)
    expect(geometry.limitY).toBeUndefined()
    expect(geometry.points).toHaveLength(2)
    expect(geometry.points[0]?.x).toBe(10)
    expect(geometry.points[1]?.x).toBe(190)
    expect(geometry.compactions[0]?.x).toBe(100)
    expect(geometry.linePath).toContain("M 10")
    expect(geometry.areaPath).toContain("Z")
  })

  test("handles empty and single-point sessions gracefully", () => {
    const empty = computeChartGeometry({
      series: buildUsageSeries([]),
      limit: 1_050_000,
      threshold: 892_500,
    })

    expect(empty.points).toEqual([])
    expect(empty.linePath).toBe("")
    expect(empty.thresholdPercent).toBe(85)
    expect(empty.thresholdY).toBeDefined()

    const single = computeChartGeometry({
      series: buildUsageSeries([
        assistantMsg(
          "a1",
          { created: 1000 },
          {
            input: 50_000,
            output: 2_500,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        ),
      ]),
      limit: 200_000,
      threshold: 170_000,
    })

    expect(single.points).toHaveLength(1)
    expect(single.linePath).toContain("M 6")
  })
})

describe("formatSessionDuration", () => {
  test("formats session durations across units", () => {
    const fmt = createSessionContextFormatter("en-US")

    expect(formatSessionDuration(undefined, 1000, "en-US")).toBe("—")
    expect(formatSessionDuration(2000, 1000, "en-US")).toBe("—")
    expect(fmt.duration(1_000, 46_000)).toBe("45s")
    expect(fmt.duration(1_000, 1_000 + 24 * 60_000)).toBe("24m")
    expect(fmt.duration(1_000, 1_000 + (2 * 60 + 14) * 60_000)).toBe("2h 14m")
    expect(fmt.duration(1_000, 1_000 + 3 * 3_600_000)).toBe("3h")
    expect(fmt.duration(1_000, 1_000 + 27 * 3_600_000)).toBe("1d 3h")
  })
})
