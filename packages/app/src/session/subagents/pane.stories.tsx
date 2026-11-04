import { STORY_TIME } from "@opencode/session-ui/storybook"
import { SubagentHeader, SubagentList } from "./pane"
import type { SubagentRow } from "./tree"

const now = STORY_TIME

const row = (input: Partial<SubagentRow> & Pick<SubagentRow, "id" | "title" | "started">): SubagentRow => ({
  depth: 0,
  agent: "explore",
  ...input,
})

const running = [
  row({
    id: "ses_scan",
    title: "Scan the timeline projection",
    status: "running",
    contextPercent: 34,
    started: now - 42_000,
    ended: now,
  }),
  row({
    id: "ses_scan_a",
    title: "Read the virtualizer",
    depth: 1,
    agent: "general",
    status: "running",
    contextPercent: 12,
    started: now - 20_000,
    ended: now,
  }),
]

const completed = [
  row({
    id: "ses_audit",
    title: "Audit the composer lane",
    status: "succeeded",
    contextPercent: 68,
    started: now - 600_000,
    ended: now - 540_000,
  }),
  row({
    id: "ses_audit_a",
    title: "Check the lane alignment in right-to-left layouts",
    depth: 1,
    agent: "general",
    status: "failed",
    contextPercent: 84,
    started: now - 590_000,
    ended: now - 560_000,
  }),
  row({
    id: "ses_audit_a1",
    title: "Compare against the review toggle",
    depth: 2,
    agent: "general",
    status: "interrupted",
    contextPercent: 19,
    started: now - 580_000,
    ended: now - 570_000,
  }),
  row({
    id: "ses_search",
    title: "Search for shell metadata",
    agent: "build",
    started: now - 3_700_000,
    ended: now - 3_600_000,
  }),
]

function Pane(props: { groups: { running: SubagentRow[]; completed: SubagentRow[] } }) {
  return (
    <div class="flex h-[520px] w-[420px] flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base pt-1 shadow-[var(--v2-elevation-raised)]">
      <SubagentList groups={props.groups} onSelect={() => {}} />
    </div>
  )
}

export default {
  title: "OpenCode/Session/Subagent tab",
  id: "session-subagent-tab",
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "The routed session's subagents as a side tab, running ones first. Nested subagents indent under the one that started them; each opens in a tab of its own.",
      },
    },
  },
}

export const RunningAndCompleted = {
  render: () => (
    <Pane groups={{ running: running.slice(0, 1), completed: completed.slice(0, 1).concat(completed.slice(3)) }} />
  ),
}

export const Nested = { render: () => <Pane groups={{ running, completed }} /> }

export const Empty = { render: () => <Pane groups={{ running: [], completed: [] }} /> }

export const Header = {
  render: () => (
    <div class="flex w-[420px] flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <SubagentHeader title="Check the lane alignment in right-to-left layouts" onOpenFull={() => {}} />
    </div>
  ),
}
