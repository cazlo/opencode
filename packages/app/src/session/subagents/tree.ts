import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { SubagentStatus } from "@/session/composer/subagent-bar"

export type SubagentRow = {
  id: string
  depth: number
  title?: string
  agent?: string
  status?: SubagentStatus
  started: number
  ended?: number
}

// The routed session's subagents, each followed by the ones it started. A top-level subagent counts as running while it
// or any subagent below it runs, as the activity capsule counts it.
export function subagentGroups(input: {
  rootID: string
  sessions: readonly SessionInfo[]
  status: (id: string) => SubagentStatus | undefined
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
        started: info.time.created,
        ended: status === "running" ? undefined : (info.time.idle ?? info.time.updated),
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
