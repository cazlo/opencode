import { Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@opencode/ui/icon"
import { Command, MenuItem, type PanelTab, type Plugin, type SessionScreen } from "@opencode/plugin/gui"
import { BuiltinPanel, builtinScreen } from "@opencode/plugin/gui/builtin"
import type definition from "./index"

// The tab that lists the routed session's subagents; every other tab id is a subagent's session id.
const LIST = "list"

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const layout = ctx.layout
  const sessions = ctx.sessions
  const key = (id: string) => `${ctx.id}:${id}`

  // One list tab for every session, so neither strip updates nor a session switch remount its trigger.
  const list: PanelTab = {
    id: LIST,
    get title() {
      return ctx.t("tab.title")
    },
    label: () => (
      <div class="flex items-center gap-2">
        <Icon name="branch-out" class="shrink-0" />
        <div>{ctx.t("tab.title")}</div>
      </div>
    ),
  }

  // Subagent tabs per screen and id; a screen outlives the sessions it routes, and the ids are unique across them.
  const tabs = new WeakMap<SessionScreen, Map<string, PanelTab>>()

  const subagentTab = (screen: SessionScreen, id: string) => {
    const cache = tabs.get(screen) ?? new Map<string, PanelTab>()
    tabs.set(screen, cache)
    const existing = cache.get(id)

    if (existing) return existing

    const subagents = builtinScreen(screen).subagents

    const tab: PanelTab = {
      id,
      get title() {
        return subagents.title(id) ?? ctx.t("tab.subagent")
      },
      // Listed only to hold a restored selection until the subagent's info loads.
      get hidden() {
        return subagents.state(id) === "pending"
      },
      label: () => (
        <div class="flex min-w-0 items-center gap-1.5">
          <Dynamic component={subagents.Status} id={id} />
          <span class="truncate">
            <bdi dir="auto">{subagents.title(id) ?? ctx.t("tab.subagent")}</bdi>
          </span>
        </div>
      ),
    }

    cache.set(id, tab)

    return tab
  }

  ctx.add(
    Command,
    (): Command => ({
      id: "toggle",
      title: ctx.t("command.toggle"),
      group: ctx.t("command.category.view"),
      section: "session",
      bind: "mod+shift+e",
      editable: true,
      enabled: !layout.narrow() && !!sessions.current(),
      run() {
        const session = sessions.current()

        if (session) layout.toggle(key(LIST), session)
      },
    }),
  )

  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = sessions.current()

    if (!session) return

    return {
      menu: "session.panel",
      id: "list",
      title: ctx.t("tab.title"),
      icon: "branch-out",
      keybind: `${ctx.id}.toggle`,
      order: 30,
      opened: layout.state(key(LIST), session) !== "closed",
      run: () => layout.open(key(LIST), session, { tab: "select" }),
    }
  })

  ctx.add(BuiltinPanel, {
    id: "main",
    region: "side",
    list: (input) =>
      input.open.flatMap((id) => {
        if (id === LIST) return [list]

        return builtinScreen(input.screen).subagents.state(id) === "gone" ? [] : [subagentTab(input.screen, id)]
      }),
    render: (props) => {
      const subagents = builtinScreen(props.screen).subagents

      return (
        <Show when={props.tab.id !== LIST} fallback={<Dynamic component={subagents.List} />}>
          {/* The subagent's own session lists neither it nor its siblings, so its tab closes on the way there. */}
          <Dynamic
            component={subagents.Transcript}
            id={props.tab.id}
            onOpenFull={() => layout.close(key(props.tab.id), props.session)}
          />
        </Show>
      )
    },
    subagent: (input) => layout.open(key(input.id), input.session, { tab: "select" }),
    close: (input) => {
      if (input.tab.id !== LIST) tabs.get(input.screen)?.delete(input.tab.id)
    },
  })
}

export default setup
