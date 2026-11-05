import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import type { SubagentStatus } from "@/session/composer/subagent-bar"

export type SubagentRow = {
  id: string
  depth: number
  title?: string
  agent?: string
  status?: SubagentStatus
  contextPercent?: number
  started: number
  ended?: number
}

// The routed session's subagents, each followed by the ones it started. A top-level subagent counts as running while it
// or any subagent below it runs, as the activity capsule counts it.
export function subagentGroups(input: {
  rootID: string
  sessions: readonly SessionInfo[]
  status: (id: string) => SubagentStatus | undefined
  ended?: (info: SessionInfo) => number
  contextPercent?: (info: SessionInfo) => number | undefined
}) {
  const children = Map.groupBy(
    input.sessions.filter((info) => info.parentID && !info.time.archived),
    (info) => info.parentID,
  )

  // A parent cycle in the data ends at the first session already walked.
  const walk = (info: SessionInfo, depth: number, seen: ReadonlySet<string>): SubagentRow[] => {
    if (seen.has(info.id)) return []
    const status = input.status(info.id)

    return [
      {
        id: info.id,
        depth,
        title: info.title,
        agent: info.agent,
        status,
        contextPercent: input.contextPercent?.(info),
        started: info.time.created,
        ended:
          status === "running" ? undefined : input.ended ? input.ended(info) : (info.time.idle ?? info.time.updated),
      },
      ...(children.get(info.id) ?? [])
        .toSorted((a, b) => a.time.created - b.time.created)
        .flatMap((child) => walk(child, depth + 1, new Set([...seen, info.id]))),
    ]
  }

  const trees = (children.get(input.rootID) ?? [])
    .toSorted((a, b) => b.time.created - a.time.created)
    .map((info) => walk(info, 0, new Set([input.rootID])))

  return {
    running: trees.filter((rows) => rows.some((row) => row.status === "running")).flat(),
    completed: trees.filter((rows) => rows.every((row) => row.status !== "running")).flat(),
  }
}

export function subagentOutcome(info: SessionInfo | undefined, messages: readonly SessionMessageInfo[]) {
  const idle = messages.findLast((message) => message.type === "idle")

  return idle?.type === "idle" ? idle.outcome : info?.outcome
}

export function subagentEnded(info: SessionInfo, messages: readonly SessionMessageInfo[]) {
  if (info.time.idle !== undefined) return info.time.idle
  const idle = messages.findLast((message) => message.type === "idle")

  return idle ? idle.time.created : info.time.updated
}

export function subagentContextPercent(
  info: SessionInfo | undefined,
  messages: readonly SessionMessageInfo[],
  contextLimit: (model: { readonly providerID: string; readonly id: string }) => number | undefined,
) {
  const message = lastAssistantWithUsage(messages, info?.revert?.messageID)

  if (!message) return undefined

  const total =
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write

  if (total <= 0) return undefined
  const limit = contextLimit(message.model)

  if (!limit || limit <= 0) return undefined

  return Math.round((total / limit) * 100)
}
