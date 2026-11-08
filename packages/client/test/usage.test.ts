import { describe, expect, test } from "bun:test"
import { compactionThreshold } from "../src/solid/usage"

describe("compactionThreshold", () => {
  test("reserves 15% of large windows, or 16k when that is more", () => {
    expect(compactionThreshold({ context: 1_050_000 })).toBe(892_500)
    expect(compactionThreshold({ context: 200_000 })).toBe(170_000)
    expect(compactionThreshold({ context: 64_000 })).toBe(48_000)
    expect(compactionThreshold({ context: 32_000 })).toBe(16_000)
  })

  test("keeps the 15% reserve on windows smaller than 32k", () => {
    expect(compactionThreshold({ context: 16_000 })).toBe(13_600)
  })

  test("measures against the smaller of the input and context limits", () => {
    expect(compactionThreshold({ context: 1_050_000, input: 590_000 })).toBe(501_500)
  })

  test("applies a token or percent buffer that leaves room, and ignores one that does not", () => {
    expect(compactionThreshold({ context: 200_000 }, 25_000)).toBe(175_000)
    expect(compactionThreshold({ context: 200_000 }, "30%")).toBe(140_000)
    expect(compactionThreshold({ context: 200_000 }, 250_000)).toBe(170_000)
  })

  test("is undefined without a window", () => {
    expect(compactionThreshold(undefined)).toBeUndefined()
    expect(compactionThreshold({ context: 0 })).toBeUndefined()
  })
})
