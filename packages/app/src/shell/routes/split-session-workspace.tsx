import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createMediaQuery } from "@solid-primitives/media"
import { createMemo, For, lazy, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode/util/encode"
import { uuid } from "@opencode/util/uuid"
import { Keybind } from "@opencode/ui/keybind"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import type { ComposerState } from "@/composer/persistence"
import { DraftRoute } from "@/new-session/route"
import { useLanguage } from "@/runtime/i18n/language"
import { same } from "@/runtime/persistence/equality"
import { ServerProvider } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerSignedOutPanel } from "@/session/server-unavailable-panel"
import { SessionPanelFrame, SessionRouteFrame } from "@/session/session-frame"
import { useCommand } from "@/shell/commands/command"
import { setPanelResizing } from "@/shell/panel-motion"
import { useLayout } from "@/shell/state/layout"
import {
  computeSessionSplitLayout,
  type SessionSplitBox,
  type SessionSplitDivider,
} from "@/shell/tabs/split-tree"
import { tabKey, tabMatchesRoute, useTabs } from "@/shell/tabs/tabs"
import { RecentlyClosedTabsMenu } from "@/shell/titlebar/recently-closed-tabs-menu"
import { TitlebarTabStrip } from "@/shell/titlebar/tab-strip"
import { requireServerKey } from "./session"
import { SessionRouteParamsProvider, useSessionRouteParams } from "./session-params"

const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

const loadSessionRoute = () => Promise.all([import("@/session/route"), File.preload()]).then(([module]) => module)

export const TargetSessionRouteContent = lazy(() =>
  loadSessionRoute().then((module) => ({ default: module.TargetSessionRouteContent })),
)

export { computeSessionSplitLayout, type SessionSplitBox, type SessionSplitDivider }

const FULL_BOX: SessionSplitBox = { x0: 0, x1: 1, y0: 0, y1: 1 }

const SPLIT_RATIO_MIN = 0.1

const SPLIT_RATIO_MAX = 0.9

export function SplitSessionWorkspace() {
  const tabs = useTabs()
  const layout = useLayout()
  const global = useGlobal()
  const language = useLanguage()
  const command = useCommand()
  const mobile = createMediaQuery("(max-width: 767px)")

  const isSplit = createMemo(() => !mobile() && tabs.split.isSplit())
  const splitLayout = createMemo(() => computeSessionSplitLayout(tabs.split.tree()))
  const dividerIds = createMemo(() => splitLayout().dividers.map((item) => item.id), [], { equals: same })
  const renderedPanes = createMemo(() => (isSplit() ? tabs.split.panes() : [tabs.split.panes()[0] ?? "main"]))

  const [size, setSize] = createStore({ width: 0, height: 0 })
  let container: HTMLDivElement | undefined

  createResizeObserver(
    () => container,
    ({ width, height }) => setSize({ width, height }),
  )

  const routedTab = createMemo(() => {
    const route = layout.route()

    if (route.type === "draft") {
      return tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
    }

    if (route.type === "session") {
      return tabs.sessionTab(route.server, route.sessionId)
    }

    return undefined
  })

  const openNewTabInPane = (paneId: string) => {
    tabs.split.focusPane(paneId)
    const tab = tabs.split.paneSelectedTab(paneId) ?? routedTab()
    const draftID = uuid()

    if (tab?.type === "draft") {
      const model = tabs.stateValue<ComposerState>(tab, "prompt")?.model.current()
      void tabs.newDraft({ server: tab.server, directory: tab.directory, draftID }, "", model)

      return
    }

    if (tab?.type === "session") {
      const pending = tabs.pendingSession(tab.server, tab.sessionId)

      if (pending) {
        const model = tabs.stateValue<ComposerState>(pending.draft, "prompt")?.model.current()
        void tabs.newDraft({ server: tab.server, directory: pending.draft.directory, draftID }, "", model)

        return
      }

      const ctx = global.serverCtx(tab.server)

      const session =
        ctx?.data.session.get(tab.routeSessionId ?? tab.sessionId) ?? ctx?.data.session.get(tab.sessionId)

      const directory = session?.location.directory ?? tabs.info[tabKey(tab)]?.directory

      if (directory) {
        const model = tabs.stateValue<ComposerState>(tab, "prompt")?.model.current()
        void tabs.newDraft({ server: tab.server, directory, draftID }, "", model)

        return
      }
    }

    command.trigger("tab.new")
  }

  return (
    <div
      ref={container}
      data-component="split-session-workspace"
      data-split={isSplit() ? "" : undefined}
      class="relative flex size-full min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <For each={renderedPanes()}>
        {(paneId) => {
          const box = createMemo(() => (isSplit() ? (splitLayout().panes.get(paneId) ?? FULL_BOX) : FULL_BOX))
          const focused = createMemo(() => !isSplit() || tabs.split.activePane() === paneId)
          const paneTab = createMemo(() => (isSplit() ? tabs.split.paneSelectedTab(paneId) : routedTab()))
          const paneTabs = createMemo(() => tabs.split.paneTabs(paneId))

          const mode = createMemo(() => {
            if (isSplit()) return paneTab()?.type === "draft" ? "draft" : "session"

            return layout.route().type === "draft" ? "draft" : "session"
          })

          const serverKey = createMemo(() => {
            const tab = paneTab()
            const route = layout.route()

            if (isSplit()) return tab?.type === "session" ? base64Encode(tab.server) : undefined

            if (route.type === "session") return base64Encode(route.server)

            return tab?.type === "session" ? base64Encode(tab.server) : undefined
          })

          const sessionId = createMemo(() => {
            const tab = paneTab()
            const route = layout.route()

            if (isSplit()) {
              if (tab?.type !== "session") return undefined

              if (focused() && route.type === "session" && tabMatchesRoute(tab, route)) return route.sessionId

              return tab.routeSessionId ?? tab.sessionId
            }

            if (route.type === "session") return route.sessionId

            return tab?.type === "session" ? (tab.routeSessionId ?? tab.sessionId) : undefined
          })

          const draftId = createMemo(() => {
            const tab = paneTab()
            const route = layout.route()

            if (isSplit()) return tab?.type === "draft" ? tab.draftID : undefined

            if (route.type === "draft") return route.draftID

            return tab?.type === "draft" ? tab.draftID : undefined
          })

          return (
            <div
              data-session-pane={paneId}
              data-focused={focused() || undefined}
              class="absolute isolate z-10 flex min-h-0 min-w-0 flex-col overflow-hidden"
              style={{
                left: `${box().x0 * 100}%`,
                top: `${box().y0 * 100}%`,
                width: `${(box().x1 - box().x0) * 100}%`,
                height: `${(box().y1 - box().y0) * 100}%`,
              }}
            >
              <Show when={isSplit()}>
                <div
                  data-session-pane-strip={paneId}
                  data-focused={focused() || undefined}
                  class="flex h-9 shrink-0 items-center gap-1 overflow-visible px-[var(--shell-inline-inset,8px)] pt-1 transition-opacity duration-150"
                  classList={{
                    "opacity-75 hover:opacity-100": !focused(),
                  }}
                  onPointerDown={(event) => {
                    if (focused()) return

                    if (event.target instanceof Element && event.target.closest("[data-titlebar-tab-slot]")) return
                    tabs.split.focusPane(paneId)
                  }}
                >
                  <TitlebarTabStrip
                    tabs={paneTabs()}
                    currentTab={paneTab()}
                    highlightActive
                    registerCommands={focused()}
                    onNavigate={(tab, el) => {
                      tabs.split.selectInPane(paneId, tab)
                      el?.scrollIntoView({ behavior: "instant" })
                    }}
                    onClose={(tab) => {
                      const index = tabs.store.findIndex((item) => tabKey(item) === tabKey(tab))

                      if (index !== -1) tabs.closeTab(index)
                    }}
                    onCloseTabs={(items, keep) => tabs.closeTabs(items.map(tabKey), keep)}
                    onReorder={(keys) => tabs.reorder(keys)}
                  />
                  <RecentlyClosedTabsMenu
                    onNewTab={() => openNewTabInPane(paneId)}
                    tooltip={
                      <>
                        {language.t("command.session.new")}
                        <Keybind keys={command.keybindParts("tab.new")} variant="neutral" />
                      </>
                    }
                  />
                </div>
              </Show>
              <div
                data-session-pane-body={paneId}
                class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                style={
                  isSplit()
                    ? {
                        "--shell-top-inset": "4px",
                      }
                    : undefined
                }
                onPointerDown={() => {
                  if (isSplit() && !focused()) tabs.split.focusPane(paneId)
                }}
                onFocusIn={() => {
                  if (isSplit() && !focused()) tabs.split.focusPane(paneId)
                }}
              >
                <SessionRouteParamsProvider
                  paneId={paneId}
                  serverKey={serverKey()}
                  id={sessionId()}
                  draftId={draftId()}
                  focused={focused()}
                  split={isSplit()}
                >
                  <Show
                    when={mode() === "draft"}
                    fallback={
                      <SessionRouteFrame>
                        <Suspense
                          fallback={
                            <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
                              <SessionPanelFrame raised />
                            </div>
                          }
                        >
                          <TargetServerRoute>
                            <TargetSessionRouteContent />
                          </TargetServerRoute>
                        </Suspense>
                      </SessionRouteFrame>
                    }
                  >
                    <Suspense
                      fallback={
                        <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
                          <SessionPanelFrame raised />
                        </div>
                      }
                    >
                      <DraftRoute />
                    </Suspense>
                  </Show>
                </SessionRouteParamsProvider>
              </div>
            </div>
          )
        }}
      </For>
      <Show when={isSplit()}>
        <For each={dividerIds()}>
          {(dividerId) => {
            const divider = createMemo(() => splitLayout().dividers.find((item) => item.id === dividerId))

            return (
              <Show when={divider()}>
                {(current) => {
                  const horizontal = () => current().direction === "horizontal"

                  const span = createMemo(() =>
                    horizontal()
                      ? Math.max(1, size.width * (current().box.x1 - current().box.x0))
                      : Math.max(1, size.height * (current().box.y1 - current().box.y0)),
                  )

                  const currentSize = createMemo(() =>
                    horizontal()
                      ? Math.round(span() * current().ratio)
                      : Math.round(span() * (1 - current().ratio)),
                  )

                  return (
                    <div
                      data-session-split-divider={current().id}
                      class="pointer-events-none absolute z-40"
                      classList={{
                        "border-e border-v2-border-border-muted/60": horizontal(),
                        "border-t border-v2-border-border-muted/60": !horizontal(),
                      }}
                      style={
                        horizontal()
                          ? {
                              left: `${current().box.x0 * 100}%`,
                              top: `${current().box.y0 * 100}%`,
                              width: `${(current().box.x1 - current().box.x0) * current().ratio * 100}%`,
                              height: `${(current().box.y1 - current().box.y0) * 100}%`,
                            }
                          : {
                              left: `${current().box.x0 * 100}%`,
                              top: `${(current().box.y0 + (current().box.y1 - current().box.y0) * current().ratio) * 100}%`,
                              width: `${(current().box.x1 - current().box.x0) * 100}%`,
                              height: `${(current().box.y1 - current().box.y0) * (1 - current().ratio) * 100}%`,
                            }
                      }
                    >
                      <ResizeHandle
                        class="pointer-events-auto z-50"
                        direction={current().direction}
                        edge={horizontal() ? "end" : "start"}
                        size={currentSize()}
                        min={Math.round(span() * SPLIT_RATIO_MIN)}
                        max={Math.round(span() * SPLIT_RATIO_MAX)}
                        onResize={(px) => {
                          const total = span()

                          if (total <= 0) return
                          const nextRatio = horizontal() ? px / total : 1 - px / total
                          tabs.split.resizeSplit(dividerId, nextRatio)
                        }}
                        onDraggingChange={setPanelResizing}
                      />
                    </div>
                  )
                }}
              </Show>
            )
          }}
        </For>
      </Show>
    </div>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useSessionRouteParams()
  const global = useGlobal()

  const connection = createMemo(() => {
    const key = params.serverKey

    if (!key) return undefined

    return global.servers.list().find((item) => ServerConnection.key(item) === requireServerKey(key))
  })

  return (
    <Show when={connection()} keyed>
      {(connection) => (
        <ServerProvider
          conn={connection}
          signedOut={
            <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
              <SessionPanelFrame raised>
                <ServerSignedOutPanel conn={connection} />
              </SessionPanelFrame>
            </div>
          }
        >
          {props.children}
        </ServerProvider>
      )}
    </Show>
  )
}
