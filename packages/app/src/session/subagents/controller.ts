import { batch, createComputed, createEffect, createMemo } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { syncWhileBooting } from "@/providers/catalog/providers"
import { same } from "@/runtime/persistence/equality"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { useCommand } from "@/shell/commands/command"
import type { SessionModel } from "@/session/model"
import type { SessionScreenLayout } from "@/session/screen-layout"
import { useOpenSessionRoute } from "@/session/session-identity-header"
import { subagentPaneLayout } from "@/session/session-panel-width"
import { useWorkspaceLocation } from "@/workspaces/location"
import { subagentContextPercent, subagentEnded, subagentGroups, subagentOutcome, type SubagentRow } from "./tree"

// The subagent pane's state: which of the routed session's subagents it shows, and whether it is open.
export function createSubagentPane(input: { session: SessionModel; screen: SessionScreenLayout }) {
  const data = useServer().ctx.data
  const sdk = useServerSDK()
  const workspaceLocation = useWorkspaceLocation()
  const command = useCommand()
  const language = useLanguage()
  const openRoute = useOpenSessionRoute()
  const view = () => input.session.layout.view().subagents
  const routed = () => input.session.identity.params.id
  // The pane remembers its selection per routed session for the life of the screen; it is not persisted. `focus` names
  // the subagent a back step left, whose row takes focus in the list, and `focusBack` moves focus into a newly entered
  // subagent once without stealing it on later passive mounts.
  const [state, setState] = createStore<{
    selection: Record<string, string | undefined>
    focus?: string
    focusBack?: string
  }>({
    selection: {},
  })
  const speculative: {
    current?: { root: string; id: string; wasOpened: boolean; previousSelection: string | undefined }
  } = {}
  // Its open state is stored with the session's tab, so without one there is nothing to open.
  const available = () => input.session.isDesktop() && !!routed() && !!input.session.layout.tabKey()
  const shown = () => available() && view().opened()

  const contextLimit = (directory: string | undefined, ref: { readonly providerID: string; readonly id: string }) => {
    const dir = directory || workspaceLocation().directory
    const models = data.location.model.list(dir ? { directory: dir } : undefined)

    if (!models) return undefined

    const model =
      models.findLast((item) => item.providerID === ref.providerID && item.id === ref.id && item.status !== "deprecated") ??
      models.findLast((item) => item.providerID === ref.providerID && item.id === ref.id)

    return model?.limit.context
  }

  const built = createMemo(() => {
    const id = routed()

    if (!id) return { running: [], completed: [] }

    return subagentGroups({
      rootID: id,
      sessions: data.session.family(id).flatMap((member) => (member === id ? [] : (data.session.get(member) ?? []))),
      status: (member) =>
        data.session.status(member) === "running"
          ? "running"
          : subagentOutcome(data.session.get(member), data.session.message.list(member)),
      ended: (info) => subagentEnded(info, data.session.message.list(info.id)),
      contextPercent: (info) =>
        subagentContextPercent(info, data.session.message.list(info.id), (model) =>
          contextLimit(info.location.directory, model),
        ),
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
    if (!shown() || sdk.connection.status() !== "connected") return

    for (const id of listed()) void data.session.sync(id, { children: true }).catch(() => undefined)
  })

  const gone = (id: string) => data.session.missing(id) || Boolean(data.session.get(id)?.time.archived)

  const lineage = (id: string, root: string): "yes" | "no" | "pending" => {
    if (id === root) return "no"
    const info = data.session.get(id)

    if (!info) return data.session.missing(id) ? "no" : "pending"
    const seen = new Set<string>([id])
    let parentID = info.parentID

    while (parentID) {
      if (parentID === root) return "yes"
      if (seen.has(parentID) || data.session.missing(parentID)) return "no"
      seen.add(parentID)
      const parent = data.session.get(parentID)
      if (!parent) return "pending"
      parentID = parent.parentID
    }

    return "no"
  }

  const uncachedAncestor = (id: string, root: string) => {
    if (id === root) return
    const info = data.session.get(id)

    if (!info) return
    const seen = new Set<string>([id])
    let parentID = info.parentID

    while (parentID && parentID !== root && !seen.has(parentID)) {
      if (data.session.missing(parentID)) return
      const parent = data.session.get(parentID)
      if (!parent) return parentID
      seen.add(parentID)
      parentID = parent.parentID
    }
  }

  const selected = createMemo(() => {
    const root = routed()
    const id = root ? state.selection[root] : undefined

    if (!root || !id || gone(id)) return

    // A subagent opened from its card can arrive before its info; it shows while that loads.
    return lineage(id, root) !== "no" ? id : undefined
  })

  // While the list itself is on screen, each listed subagent's messages and model catalog load so its outcome, end
  // time, and context window percentage render before the subagent is opened.
  createEffect(() => {
    if (!shown() || selected() || sdk.connection.status() !== "connected") return
    const ids = listed()
    const directories = new Set<string>()
    const fallback = workspaceLocation().directory

    if (fallback) directories.add(fallback)

    for (const id of ids) {
      void data.session.message.sync(id).catch(() => undefined)
      const dir = data.session.get(id)?.location.directory

      if (dir) directories.add(dir)
    }

    if (directories.size === 0) {
      void (async () => {
        await data.location.syncInfo()
        await syncWhileBooting(() => data.location.model.sync(data.location.default()))
      })().catch(() => undefined)

      return
    }

    for (const directory of directories) {
      void syncWhileBooting(() => data.location.model.sync({ directory })).catch(() => undefined)
    }
  })

  const select = (id: string | undefined, focus?: string, keepSpeculative?: boolean) => {
    const root = routed()

    if (!root) return
    if (!keepSpeculative && speculative.current?.root === root) speculative.current = undefined
    const shouldFocusBack = !!id && (typeof document === "undefined" || !editable(document.activeElement))
    batch(() => {
      setState("selection", root, id)
      setState("focus", focus)
      setState("focusBack", shouldFocusBack ? id : undefined)
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

  // Cleans up missing or archived selections, and redirects a speculatively opened subagent that turns out not to
  // belong to this session, such as one a fork copied, onto its own route while preserving any already-open pane state.
  createEffect(() => {
    const root = routed()
    if (speculative.current && speculative.current.root !== root) speculative.current = undefined
    const id = root ? state.selection[root] : undefined

    if (!root || !id) return
    const pending = speculative.current?.root === root && speculative.current.id === id ? speculative.current : undefined

    if (data.session.missing(id)) {
      if (pending) {
        speculative.current = undefined
        batch(() => {
          setState("selection", root, pending.previousSelection)
          setState("focusBack", undefined)
          if (!pending.wasOpened) view().setOpened(false)
        })
        return
      }
      setState("selection", root, undefined)
      return
    }

    if (data.session.get(id)?.time.archived) {
      if (pending) {
        const active = shown()
        speculative.current = undefined
        batch(() => {
          setState("selection", root, pending.previousSelection)
          setState("focusBack", undefined)
          if (!pending.wasOpened) view().setOpened(false)
        })
        if (active) openRoute(root, id)
        return
      }
      setState("selection", root, undefined)
      return
    }

    const ancestor = uncachedAncestor(id, root)
    if (ancestor) {
      void data.session.sync(ancestor).catch(() => undefined)
      return
    }

    const relation = lineage(id, root)
    if (relation === "yes") {
      if (pending) speculative.current = undefined
      return
    }

    if (relation === "no") {
      if (pending) {
        const active = shown()
        speculative.current = undefined
        batch(() => {
          setState("selection", root, pending.previousSelection)
          setState("focusBack", undefined)
          if (!pending.wasOpened) view().setOpened(false)
        })
        if (active) openRoute(root, id)
        return
      }
      setState("selection", root, undefined)
    }
  })

  const close = () => {
    const pending = speculative.current?.root === routed() ? speculative.current : undefined
    if (pending) speculative.current = undefined
    const restoreFocus =
      typeof document !== "undefined" &&
      document.getElementById("subagent-pane")?.contains(document.activeElement) === true
    batch(() => {
      if (pending) setState("selection", pending.root, pending.previousSelection)
      setState("focus", undefined)
      setState("focusBack", undefined)
      view().setOpened(false)
    })
    if (restoreFocus) document.querySelector<HTMLElement>('button[aria-controls="subagent-pane"]')?.focus()
  }

  const toggle = () => {
    if (view().opened()) {
      close()
      return
    }
    view().setOpened(true)
  }

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
    focusBack: () => state.focusBack,
    clearFocus: () => setState("focus", undefined),
    clearFocusBack: () => setState("focusBack", undefined),
    selected,
    select: (id: string | undefined, focus?: string) => select(id, focus),
    toggle,
    close,
    openFull,
    // On desktop subagents opened from the transcript or the activity capsule open here rather than replacing the
    // transcript. One that is not this session's own, or no pane to open, is left to the caller's route.
    openInPane: (id: string) => {
      const root = routed()

      if (!root || !available() || gone(id)) return false
      const relation = lineage(id, root)
      if (relation === "no") return false

      if (relation !== "pending" && speculative.current?.root === root) speculative.current = undefined
      if (relation === "pending") {
        const existing = speculative.current?.root === root ? speculative.current : undefined
        speculative.current = {
          root,
          id,
          wasOpened: existing ? existing.wasOpened : view().opened(),
          previousSelection: existing ? existing.previousSelection : state.selection[root],
        }
      }

      view().setOpened(true)
      select(id, undefined, relation === "pending")

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

function editable(node: Element | null) {
  return node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName))
}
