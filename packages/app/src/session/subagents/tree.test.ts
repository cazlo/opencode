import { expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { SubagentStatus } from "@/session/composer/subagent-bar"
import { subagentGroups, subagentOutcome } from "./tree"

function info(id: string, parentID: string | undefined, created: number, extra: Partial<SessionInfo> = {}) {
  // SAFETY: the fixtures set every field these functions read; the branded ids are plain strings in them.
  return {
    id,
    parentID,
    projectID: "project-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: created + 5 },
    title: id,
    location: { directory: "/repo" },
    ...extra,
  } as SessionInfo
}

type Case = {
  name: string
  rootID: string
  sessions: SessionInfo[]
  status: Record<string, SubagentStatus>
  running: string[]
  completed: string[]
}

const names = (rows: { id: string; depth: number }[]) => rows.map((row) => `${row.id}:${row.depth}`)

test.each<Case>([
  {
    name: "splits running from completed, newest first, with children after their parent",
    rootID: "root",
    sessions: [
      info("old", "root", 1),
      info("new", "root", 3),
      info("running", "root", 2),
      info("old-b", "old", 5),
      info("old-a", "old", 4),
    ],
    status: { running: "running", old: "succeeded", new: "failed", "old-a": "succeeded", "old-b": "interrupted" },
    running: ["running:0"],
    completed: ["new:0", "old:0", "old-a:1", "old-b:1"],
  },
  {
    name: "counts a completed subagent as running while a subagent below it runs",
    rootID: "root",
    sessions: [info("child", "root", 1), info("grandchild", "child", 2)],
    status: { child: "succeeded", grandchild: "running" },
    running: ["child:0", "grandchild:1"],
    completed: [],
  },
  {
    name: "leaves out archived subagents",
    rootID: "root",
    sessions: [info("live", "root", 1), info("gone", "root", 2, { time: { created: 2, updated: 3, archived: 9 } })],
    status: { live: "succeeded" },
    running: [],
    completed: ["live:0"],
  },
  {
    // The routed session is its own descendant: its parent is one of its subagents' subagents.
    name: "ends at a parent cycle through the routed session",
    rootID: "root",
    sessions: [info("a", "root", 1), info("b", "a", 2), info("root", "b", 0)],
    status: { a: "succeeded", b: "succeeded", root: "succeeded" },
    running: [],
    completed: ["a:0", "b:1"],
  },
  {
    name: "leaves out the siblings and parent of a routed subagent",
    rootID: "child",
    sessions: [
      info("parent", undefined, 0),
      info("child", "parent", 1),
      info("sibling", "parent", 2),
      info("mine", "child", 3),
    ],
    status: { mine: "succeeded", sibling: "running" },
    running: [],
    completed: ["mine:0"],
  },
])("$name", (input) => {
  const groups = subagentGroups({
    rootID: input.rootID,
    sessions: input.sessions,
    status: (id) => input.status[id],
  })

  expect({ running: names(groups.running), completed: names(groups.completed) }).toEqual({
    running: input.running,
    completed: input.completed,
  })
})

test("a running subagent has no end time and a finished one ends when it went idle", () => {
  const finished = info("done", "root", 1, { time: { created: 1, updated: 7, idle: 6 } })

  const groups = subagentGroups({
    rootID: "root",
    sessions: [finished, info("busy", "root", 2)],
    status: (id) => (id === "busy" ? "running" : "succeeded"),
  })

  expect([groups.running[0]?.ended, groups.completed[0]?.ended]).toEqual([undefined, 6])
})

test("the outcome is the latest idle message's, else the session's", () => {
  const idle = (id: string, outcome: "succeeded" | "failed"): SessionMessageInfo => ({
    id,
    type: "idle",
    time: { created: 1 },
    outcome,
  })

  const session = info("child", "root", 1, { outcome: "interrupted" })

  expect([
    subagentOutcome(session, [idle("a", "failed"), idle("b", "succeeded")]),
    subagentOutcome(session, []),
    subagentOutcome(undefined, []),
  ]).toEqual(["succeeded", "interrupted", undefined])
})
