import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useCommand } from "@/shell/commands/command"
import type { SessionModel } from "@/session/model"
import type { SessionScreenLayout } from "@/session/screen-layout"
import { subagentPaneLayout } from "@/session/session-panel-width"
import { subagentGroups, subagentOutcome } from "./tree"

// The subagent pane's state: which of the routed session's subagents it shows, and whether it is open.
export function createSubagentPane(input: { session: SessionModel; screen: SessionScreenLayout }) {
  const data = useServer().ctx.data
  const command = useCommand()
  const language = useLanguage()
  const view = () => input.session.layout.view().subagents
  const routed = () => input.session.identity.params.id
  // The pane remembers its selection per routed session for the life of the screen; it is not persisted.
  const [state, setState] = createStore<{ selection: Record<string, string | undefined> }>({ selection: {} })
  const available = () => input.session.isDesktop() && !!routed()
  const shown = () => available() && view().opened()

  const groups = createMemo(() => {
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

  const select = (id: string | undefined) => {
    const root = routed()

    if (root) setState("selection", root, id)
  }

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
    groups,
    selected,
    select,
    toggle,
    close: () => view().setOpened(false),
    // On desktop subagents opened from the transcript or the activity capsule open here rather than replacing the
    // transcript; elsewhere the caller opens the subagent's own session.
    openInPane: (id: string) => {
      if (!available()) return false
      view().setOpened(true)
      select(id)

      return true
    },
    // Back to the subagent that started this one, or to the list when the routed session did.
    back: () => {
      const parentID = data.session.get(selected() ?? "")?.parentID

      select(parentID && parentID !== routed() ? parentID : undefined)
    },
    layout: createMemo(() => subagentPaneLayout({ chat: input.screen.panel.chatWidth(), width: view().width() })),
    resize: (width: number) => view().resize(width),
    toggleVisible: () => available() && (view().opened() || groups().running.length + groups().completed.length > 0),
  }
}

export type SubagentPaneModel = ReturnType<typeof createSubagentPane>
