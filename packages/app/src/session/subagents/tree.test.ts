import { expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { SubagentStatus } from "@/session/composer/subagent-bar"
import { subagentContextPercent, subagentEnded, subagentGroups, subagentOutcome } from "./tree"

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

test("subagentEnded prefers time.idle, else the latest idle message, else time.updated", () => {
  const idle = (id: string, created: number): SessionMessageInfo => ({
    id,
    type: "idle",
    time: { created },
    outcome: "succeeded",
  })

  expect([
    subagentEnded(info("with-idle", "root", 1, { time: { created: 1, updated: 9, idle: 6 } }), [idle("m1", 5)]),
    subagentEnded(info("legacy", "root", 1, { time: { created: 1, updated: 9 } }), [idle("m1", 4), idle("m2", 7)]),
    subagentEnded(info("no-messages", "root", 1, { time: { created: 1, updated: 9 } }), []),
  ]).toEqual([6, 7, 9])
})

test("subagentContextPercent computes context occupancy from the latest assistant step after compaction and before revert", () => {
  const step = (
    id: string,
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
    modelID = "claude-opus-4-6",
  ): SessionMessageInfo =>
    // SAFETY: fixture covers every field lastAssistantWithUsage and subagentContextPercent read.
    ({
      id,
      type: "assistant",
      agent: "explore",
      model: { providerID: "opencode", id: modelID },
      content: [],
      tokens,
      time: { created: 1 },
    }) as SessionMessageInfo

  const compaction = (id: string, status: "running" | "completed"): SessionMessageInfo =>
    // SAFETY: fixture covers every field lastAssistantWithUsage reads on compaction messages.
    ({
      id,
      type: "compaction",
      status,
      reason: "auto",
      summary: "",
      time: { created: 2 },
    }) as SessionMessageInfo

  const limit = (model: { readonly providerID: string; readonly id: string }) =>
    model.providerID === "opencode" && model.id === "claude-opus-4-6" ? 200_000 : undefined

  const session = info("child", "root", 1)

  const messages: SessionMessageInfo[] = [
    step("msg_1", { input: 20_000, output: 5_000, reasoning: 5_000, cache: { read: 10_000, write: 10_000 } }),
    step("msg_2", { input: 40_000, output: 10_000, reasoning: 10_000, cache: { read: 30_000, write: 10_000 } }),
    step("msg_streaming"),
  ]

  expect(subagentContextPercent(session, messages, limit)).toBe(50)

  // SAFETY: revert only needs messageID for lastAssistantWithUsage; branded SessionMessageID is a plain string in tests.
  const reverted = info("child", "root", 1, { revert: { messageID: "msg_2" } } as Partial<SessionInfo>)
  expect(subagentContextPercent(reverted, messages, limit)).toBe(25)

  const compacted = [...messages, compaction("msg_compact", "completed")]
  expect(subagentContextPercent(session, compacted, limit)).toBeUndefined()
  expect(
    subagentContextPercent(
      session,
      [...compacted, step("msg_after", { input: 24_000, output: 6_000, reasoning: 0, cache: { read: 0, write: 0 } })],
      limit,
    ),
  ).toBe(15)

  expect(
    subagentContextPercent(
      session,
      [step("msg_zero", { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })],
      limit,
    ),
  ).toBeUndefined()
  expect(
    subagentContextPercent(
      session,
      [step("msg_unknown", { input: 10_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, "missing")],
      limit,
    ),
  ).toBeUndefined()

  const groups = subagentGroups({
    rootID: "root",
    sessions: [session],
    status: () => "succeeded",
    contextPercent: (item) => subagentContextPercent(item, messages, limit),
  })

  expect(groups.completed[0]?.contextPercent).toBe(50)
})
