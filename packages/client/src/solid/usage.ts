import type { SessionMessageAssistant, SessionMessageInfo } from "../promise"

/**
 * The assistant step whose tokens fill the context window now: the latest one after the last completed
 * compaction and before the revert boundary. Every client shows context usage from this step, so the TUI
 * and the desktop app agree on it.
 */
export function lastAssistantWithUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1

  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )

  return messages.findLast(
    (message, index): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

const COMPACTION_RESERVE_MIN = 16_000

const COMPACTION_RESERVE_SHARE = 0.15

/**
 * The prompt size at which automatic compaction starts, mirroring `calculateCeiling` in core's compaction: the input
 * window minus `max(floor(window * 0.15), window >= 32k ? 16k : 0)`, or minus `buffer` (tokens, or a percent string)
 * when it leaves room. Context usage percentages are measured against this, not the advertised context window.
 */
export function compactionThreshold(
  limit: { readonly context?: number; readonly input?: number } | undefined,
  buffer?: number | string,
) {
  if (!limit) return undefined

  const window = limit.input && limit.context ? Math.min(limit.input, limit.context) : limit.input || limit.context || 0

  if (window <= 0) return undefined
  const tokens = typeof buffer === "string" ? Math.round((window * Number.parseFloat(buffer)) / 100) : buffer

  if (tokens !== undefined && Number.isFinite(tokens) && tokens >= 0 && tokens < window) return window - tokens

  return (
    window -
    Math.max(
      Math.floor(window * COMPACTION_RESERVE_SHARE),
      window >= 2 * COMPACTION_RESERVE_MIN ? COMPACTION_RESERVE_MIN : 0,
    )
  )
}

/** Tokens a step's prompt and reply occupy in the context window. */
export function contextTokens(tokens: {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/** Percent of the compaction threshold `tokens` fills; can pass 100 when a step crosses it. */
export function contextPercent(tokens: number, threshold: number | undefined) {
  if (!threshold || threshold <= 0) return undefined

  return Math.round((tokens / threshold) * 100)
}
