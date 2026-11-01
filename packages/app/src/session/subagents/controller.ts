import { batch, createComputed, createEffect, createMemo } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { same } from "@/runtime/persistence/equality"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useCommand } from "@/shell/commands/command"
import type { SessionModel } from "@/session/model"
import type { SessionScreenLayout } from "@/session/screen-layout"
import { useOpenSessionRoute } from "@/session/session-identity-header"
import { subagentPaneLayout } from "@/session/session-panel-width"
import { subagentGroups, subagentOutcome, type SubagentRow } from "./tree"

// The subagent pane's state: which of the routed session's subagents it shows, and whether it is open.
export function createSubagentPane(input: { session: SessionModel; screen: SessionScreenLayout }) {
  const data = useServer().ctx.data
  const command = useCommand()
  const language = useLanguage()
  const openRoute = useOpenSessionRoute()
  const view = () => input.session.layout.view().subagents
  const routed = () => input.session.identity.params.id
  // The pane remembers its selection per routed session for the life of the screen; it is not persisted. `focus` names
  // the subagent a back step left, whose row takes focus in the list.
  const [state, setState] = createStore<{ selection: Record<string, string | undefined>; focus?: string }>({
    selection: {},
  })
  // Its open state is stored with the session's tab, so without one there is nothing to open.
  const available = () => input.session.isDesktop() && !!routed() && !!input.session.layout.tabKey()
  const shown = () => available() && view().opened()

  const built = createMemo(() => {
    const id = routed()

    if (!id) return { running: [], completed: [] }

    return subagentGroups({
      rootID: id,
      sessions: data.session.family(id).flatMap((member) => data.session.get(member) ?? []),
      status: (member) =>
        data.session.status(member) === "running"
          ? "running"
          : subagentOutcome(data.session.get(member), data.session.message.list(member)),
    })
  })

  // Rows keep their identity by id as the data under them changes, so the list updates them in place rather than
  // rebuilding its buttons, which would drop focus and swallow clicks.
  const [groups, setGroups] = createStore<{ running: SubagentRow[]; completed: SubagentRow[] }>({
    running: [],
    completed: [],
  })

  createComputed(() => setGroups(reconcile(built())))

  const listed = createMemo(() => [...groups.running, ...groups.completed].map((row) => row.id), [], { equals: same })

  // A subagent's own subagents load with it, so the list shows nested ones before the subagent is opened. Each load
  // lists more subagents, which load in turn.
  createEffect(() => {
    if (!shown()) return

    for (const id of listed()) void data.session.sync(id, { children: true }).catch(() => undefined)
  })

  const descends = (id: string, root: string) => {
    const seen = new Set<string>()
    let parentID = data.session.get(id)?.parentID

    while (parentID && !seen.has(parentID)) {
      if (parentID === root) return true
      seen.add(parentID)
      parentID = data.session.get(parentID)?.parentID
    }

    return false
  }

  const selected = createMemo(() => {
    const root = routed()
    const id = root ? state.selection[root] : undefined

    if (!root || !id || data.session.missing(id)) return

    // A subagent opened from its card can arrive before its info; it shows while that loads.
    return !data.session.get(id) || descends(id, root) ? id : undefined
  })

  const select = (id: string | undefined, focus?: string) => {
    const root = routed()

    if (!root) return
    batch(() => {
      setState("selection", root, id)
      setState("focus", focus)
    })
  }

  // Leaves the pane for the subagent's own session, as before the pane existed.
  const openFull = (id: string) => {
    const root = routed()

    if (!root) return
    select(undefined)
    view().setOpened(false)
    openRoute(root, id)
  }

  // A subagent that turns out, once its info arrives, not to belong to this session, such as one a fork copied, has
  // no place in the list; it opens on its own route.
  createEffect(() => {
    const root = routed()
    const id = root ? state.selection[root] : undefined

    if (root && id && data.session.get(id) && !descends(id, root)) openFull(id)
  })

  const toggle = () => view().setOpened(!view().opened())

  command.register("subagents", () => [
    {
      id: "session.subagents.toggle",
      category: language.t("command.category.view"),
      title: language.t("command.session.subagents.toggle"),
      keybind: "mod+shift+e",
      disabled: !available(),
      onSelect: toggle,
    },
  ])

  return {
    routed,
    shown,
    groups: () => groups,
    focus: () => state.focus,
    selected,
    select,
    toggle,
    close: () => {
      view().setOpened(false)
      document.querySelector<HTMLElement>('button[aria-controls="subagent-pane"]')?.focus()
    },
    openFull,
    // On desktop subagents opened from the transcript or the activity capsule open here rather than replacing the
    // transcript. One that is not this session's own, or no pane to open, is left to the caller's route.
    openInPane: (id: string) => {
      const root = routed()

      if (!root || !available()) return false

      if (data.session.get(id) && !descends(id, root)) return false
      view().setOpened(true)
      select(id)

      return true
    },
    // Back to the subagent that started this one, or to the list when the routed session did.
    back: () => {
      const from = selected()
      const parentID = data.session.get(from ?? "")?.parentID

      select(parentID && parentID !== routed() ? parentID : undefined, from)
    },
    layout: createMemo(() => subagentPaneLayout({ chat: input.screen.panel.chatWidth(), width: view().width() })),
    resize: (width: number) => view().resize(width),
    toggleVisible: () => available() && (view().opened() || groups.running.length + groups.completed.length > 0),
  }
}

export type SubagentPaneModel = ReturnType<typeof createSubagentPane>
