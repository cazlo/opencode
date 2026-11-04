import { createComputed, createEffect, createMemo, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { MountedSession, SessionScreen } from "@opencode/plugin/gui"
import { BuiltinPanel, type SubagentState } from "@opencode/plugin/gui/builtin"
import { syncWhileBooting } from "@/providers/catalog/providers"
import { same } from "@/runtime/persistence/equality"
import { usePluginHost } from "@/runtime/plugin/host"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import type { SessionModel } from "@/session/model"
import { useOpenSessionRoute } from "@/session/session-identity-header"
import { useWorkspaceLocation } from "@/workspaces/location"
import { subagentContextPercent, subagentEnded, subagentGroups, subagentOutcome, type SubagentRow } from "./tree"

// Where the routed session's subagents open: a side panel that shows subagents takes those opened from the transcript,
// once each is known to be this session's own; the rest open on their own route.
export function createSessionSubagents(input: {
  session: SessionModel
  view: Accessor<MountedSession>
  screen: SessionScreen
}) {
  const data = useServer().ctx.data
  const host = usePluginHost()
  const openRoute = useOpenSessionRoute()
  const routed = () => input.session.identity.params.id
  // Side tabs are stored with the session's shell tab, so without one there is nowhere to open a subagent.
  const available = () => input.session.isDesktop() && !!routed() && !!input.session.layout.tabKey()
  const panel = () => host.items(BuiltinPanel).find((item) => item.value.subagent)?.value

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
    const seen = new Set<string>([id])
    let parentID = data.session.get(id)?.parentID

    while (parentID && parentID !== root && !seen.has(parentID)) {
      if (data.session.missing(parentID)) return
      const parent = data.session.get(parentID)

      if (!parent) return parentID
      seen.add(parentID)
      parentID = parent.parentID
    }
  }

  // Loads a subagent's info and then each ancestor's until its lineage is known. A load that fails leaves it pending.
  const settle = async (id: string, root: string) => {
    if (!data.session.get(id) && !data.session.missing(id)) await data.session.sync(id).catch(() => undefined)

    for (let ancestor = uncachedAncestor(id, root); ancestor; ancestor = uncachedAncestor(id, root)) {
      await data.session.sync(ancestor).catch(() => undefined)

      if (!data.session.get(ancestor) && !data.session.missing(ancestor)) break
    }

    return lineage(id, root)
  }

  const show = (id: string) => panel()?.subagent?.({ session: input.view(), screen: input.screen, id })

  // A stored subagent tab can be read before its info loads, e.g. after a reload. Its first read starts the load, once
  // per screen, after the read that asked for it.
  const settling = new Set<string>()

  const state = (id: string): SubagentState => {
    const root = routed()

    if (!root || gone(id)) return "gone"
    const relation = lineage(id, root)

    if (relation === "yes") return "listed"

    if (relation === "no") return "gone"

    if (!settling.has(`${root}/${id}`)) {
      settling.add(`${root}/${id}`)
      queueMicrotask(() => void settle(id, root))
    }

    return "pending"
  }

  return {
    state,
    title: (id: string) => data.session.get(id)?.title,
    /**
     * Opens a subagent from the routed transcript or the activity capsule beside it, and says whether it took it. One
     * that is not this session's own, or with no panel to show it, is left to the caller's route.
     */
    open: (id: string) => {
      const root = routed()

      if (!root || !available() || !panel() || gone(id)) return false
      const relation = lineage(id, root)

      if (relation === "no") return false

      if (relation === "yes") {
        show(id)

        return true
      }

      // A card can name a subagent before its info arrives: it opens where it belongs once that loads.
      void settle(id, root).then((settled) => {
        if (routed() !== root) return

        if (settled === "yes") return show(id)
        openRoute(root, id)
      })

      return true
    },
    // Leaves the side tab for the subagent's own session, as before subagents opened beside the transcript.
    openFull: (id: string) => {
      const root = routed()

      if (root) openRoute(root, id)
    },
  }
}

export type SessionSubagentsModel = ReturnType<typeof createSessionSubagents>

// The routed session's subagents for the list tab, which loads what each row shows while it is mounted.
export function createSubagentGroups(routed: Accessor<string | undefined>) {
  const data = useServer().ctx.data
  const sdk = useServerSDK()
  const workspaceLocation = useWorkspaceLocation()

  const contextLimit = (directory: string | undefined, ref: { readonly providerID: string; readonly id: string }) => {
    const dir = directory || workspaceLocation().directory
    const models = data.location.model.list(dir ? { directory: dir } : undefined)

    if (!models) return undefined

    const model =
      models.findLast(
        (item) => item.providerID === ref.providerID && item.id === ref.id && item.status !== "deprecated",
      ) ?? models.findLast((item) => item.providerID === ref.providerID && item.id === ref.id)

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
    if (sdk.connection.status() !== "connected") return

    for (const id of listed()) void data.session.sync(id, { children: true }).catch(() => undefined)
  })

  // Each listed subagent's messages and model catalog load so its outcome, end time, and context window percentage
  // render before the subagent is opened.
  createEffect(() => {
    if (sdk.connection.status() !== "connected") return
    const directories = new Set<string>()
    const fallback = workspaceLocation().directory

    if (fallback) directories.add(fallback)

    for (const id of listed()) {
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

  return groups
}
