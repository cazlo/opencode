import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { contextPercent, contextTokens, lastAssistantWithUsage } from "@opencode/client/solid"
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
    // Most recently finished first; a tree finishes with its last subagent. The sort is stable, so ties keep the
    // newest-started first.
    completed: trees
      .filter((rows) => rows.every((row) => row.status !== "running"))
      .map((rows) => ({ rows, ended: Math.max(...rows.map((row) => row.ended ?? row.started)) }))
      .toSorted((a, b) => b.ended - a.ended)
      .flatMap((tree) => tree.rows),
  }
}

// Running rows share a section with the finished subagents below or beside them, so only the running ones count.
export function subagentCounts(groups: { running: readonly SubagentRow[]; completed: readonly SubagentRow[] }) {
  return {
    running: groups.running.filter((row) => row.status === "running").length,
    completed: groups.completed.length,
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

// Percent of its compaction threshold the subagent's latest step fills, as every context percentage is measured.
export function subagentContextPercent(
  info: SessionInfo | undefined,
  messages: readonly SessionMessageInfo[],
  threshold: (model: { readonly providerID: string; readonly id: string }) => number | undefined,
) {
  const message = lastAssistantWithUsage(messages, info?.revert?.messageID)

  if (!message) return undefined
  const total = contextTokens(message.tokens)

  if (total <= 0) return undefined

  return contextPercent(total, threshold(message.model))
}
