import { createEffect, createMemo, ErrorBoundary, on, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { MountedSession, SessionScreen } from "@opencode/plugin/gui"
import type { SessionUserActions } from "@opencode/session-ui/actions"
import { DataContext, useData } from "@opencode/session-ui/context"
import { frameLoop } from "@opencode/ui/motion"
import { Loader } from "@opencode/ui/loader"
import { base64Encode } from "@opencode/util/encode"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { SessionRouteKey, SessionStateKey } from "@/runtime/server/scope"
import { useWorkspaceLocation } from "@/workspaces/location"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { setPanelResizing } from "@/shell/panel-motion"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { SubagentBar } from "@/session/composer/subagent-bar"
import type { TimelineActionsView } from "@/session/composer/timeline-actions"
import type { SessionModel } from "@/session/model"
import { SUBAGENT_PANE_WIDTH_MIN } from "@/session/session-panel-width"
import { sessionTitle } from "@/session/title"
import type { TimelineSessionSource } from "@/session/timeline/controller"
import { MessageTimeline } from "@/session/timeline/message-timeline"
import { PluginLinks } from "@/runtime/plugin/render"
import {
  enrichLeadingTurn,
  leadingTurnPageDelay,
  leadingTurnPageLimit,
  loadOlderTimeline,
} from "@/session/timeline/model"
import type { SubagentPaneModel } from "./controller"
import { createSubagentModelLabel } from "./model-label"
import { SubagentList, SubagentPaneFrame } from "./pane"
import { subagentOutcome } from "./tree"

// The routed session's subagents beside its transcript: a list of them, and any one's live, read-only transcript.
export function SubagentPane(props: {
  pane: SubagentPaneModel
  session: SessionModel
  view: Accessor<MountedSession>
  screen: SessionScreen
  actions: (view: TimelineActionsView) => SessionUserActions
  /** The floating review toggle sits over the pane's header. */
  reserveReviewToggle: boolean
  /** Clears a blocking request dock beneath a floating pane. */
  bottomOffset?: number
}) {
  const language = useLanguage()
  const data = useServer().ctx.data
  const bottom = () => (props.pane.layout().docked ? undefined : `${Math.max(0, props.bottomOffset ?? 0)}px`)

  return (
    // The handle straddles the pane's edge, so the frame clips and this wrapper does not.
    <aside
      id="subagent-pane"
      aria-label={language.t("session.subagents.title")}
      class="flex min-h-0 shrink-0"
      classList={{
        "relative h-full": props.pane.layout().docked,
        // Over the composer, which draws above the transcript's frame, except when a blocking prompt waits there.
        "absolute top-0 end-0 z-[80]": !props.pane.layout().docked,
      }}
      style={{ width: `${props.pane.layout().width}px`, bottom: bottom() }}
    >
      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={props.pane.layout().width}
        min={SUBAGENT_PANE_WIDTH_MIN}
        max={props.pane.layout().max}
        onResize={props.pane.resize}
        onDraggingChange={setPanelResizing}
      />
      <div
        class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base"
        classList={{
          "shadow-[var(--v2-elevation-raised)]": props.pane.layout().docked,
          "shadow-[var(--v2-elevation-floating)]": !props.pane.layout().docked,
        }}
      >
        <Show
          when={props.pane.selected()}
          keyed
          fallback={
            <SubagentPaneFrame
              title={language.t("session.subagents.title")}
              onClose={props.pane.close}
              reserveReviewToggle={props.reserveReviewToggle}
            >
              <SubagentList
                groups={props.pane.groups()}
                onSelect={props.pane.select}
                focus={props.pane.focus()}
                onAutoFocus={props.pane.clearFocus}
              />
            </SubagentPaneFrame>
          }
        >
          {(id) => (
            <SubagentPaneFrame
              title={sessionTitle(data.session.get(id)?.title) ?? language.t("session.tab.session")}
              onBack={props.pane.back}
              onOpenFull={() => props.pane.openFull(id)}
              onClose={props.pane.close}
              autoFocusBack={props.pane.focusBack() === id}
              onAutoFocus={props.pane.clearFocusBack}
              reserveReviewToggle={props.reserveReviewToggle}
            >
              <ErrorBoundary
                fallback={
                  <p class="m-auto text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                    {language.t("common.requestFailed")}
                  </p>
                }
              >
                <SubagentTranscript
                  id={id}
                  pane={props.pane}
                  session={props.session}
                  view={props.view}
                  screen={props.screen}
                  actions={props.actions}
                />
              </ErrorBoundary>
            </SubagentPaneFrame>
          )}
        </Show>
      </div>
    </aside>
  )
}

function SubagentTranscript(props: {
  id: string
  pane: SubagentPaneModel
  session: SessionModel
  view: Accessor<MountedSession>
  screen: SessionScreen
  actions: (view: TimelineActionsView) => SessionUserActions
}) {
  // The pane is keyed by the selected subagent, so this component reads one id for its life.
  const id = untrack(() => props.id)
  const language = useLanguage()
  const server = useServer()
  const serverSDK = useServerSDK()
  const location = useWorkspaceLocation()
  const ui = useData()
  const data = server.ctx.data
  const [load, setLoad] = createStore<{ state: "loading" | "ready" | "failed"; stopping: boolean }>({
    state: "loading",
    stopping: false,
  })

  let current = true
  onCleanup(() => (current = false))

  const info = () => data.session.get(id)
  const directory = () => info()?.location.directory ?? location().directory
  const messages = () => data.session.message.list(id)
  const more = () => data.session.message.more(id)
  const loading = () => data.session.message.loading(id)

  // Queued input that has not been delivered is no transcript: alone it does not count as loaded.
  const ready = () => load.state === "ready" || messages().some((message) => !data.session.input.has(id, message.id))

  const follow = createSubagentTimelineFollow({
    current: () => current,
    ready,
    count: () => messages().length,
    more,
    loading,
    loadOlder: () =>
      loadOlderTimeline({
        sessionID: () => id,
        more,
        loading,
        loadMore: (target) => data.session.message.loadMore(target),
      }),
  })

  // Like the routed timeline's load, a first page that starts mid-turn is completed with the turn's opening prompt.
  createEffect(
    on(
      () => serverSDK.connection.status(),
      (status) => {
        if (status !== "connected") return
        let active = true
        onCleanup(() => (active = false))

        if (load.state === "failed") setLoad("state", "loading")

        void Promise.all([
          data.session.message.sync(id),
          data.session.pending.sync(id),
          data.session.permission.sync(id),
          data.session.form.sync(id),
          data.session.sync(id, { children: true }),
        ])
          .then(() => {
            if (!active) return
            return enrichLeadingTurn({
              current: () => current && active,
              messages,
              more,
              loading,
              loadMore: () => data.session.message.loadMore(id),
              pause: () => new Promise((resolve) => setTimeout(resolve, leadingTurnPageDelay)),
              maxPages: leadingTurnPageLimit,
            }).catch(() => undefined)
          })
          .then(
            () => {
              if (!active) return
              setLoad("state", "ready")
              follow.fill()
            },
            () => {
              if (active) setLoad("state", "failed")
            },
          )
      },
    ),
  )

  const stop = () => {
    if (load.stopping) return
    setLoad("stopping", true)
    void serverSDK.api.session
      .interrupt({ sessionID: id })
      .catch((error) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(error, language.t("common.requestFailed")),
        })
      })
      .finally(() => {
        if (current) setLoad("stopping", false)
      })
  }

  // Mirrors the routed session's key, so what the timeline stores about this subagent belongs to its own route.
  const sessionKey = createMemo(() =>
    SessionStateKey.from(serverSDK.scope, SessionRouteKey.fromRoute(base64Encode(directory()), id)),
  )

  const source: TimelineSessionSource = {
    identity: { params: props.session.identity.params, sessionID: () => id, sessionKey },
    data: {
      info,
      parentID: () => info()?.parentID,
      parent: () => {
        const parentID = info()?.parentID

        return parentID ? data.session.get(parentID) : undefined
      },
      status: createMemo(() =>
        data.session.status(id) === "running" ? { type: "busy" as const } : { type: "idle" as const },
      ),
    },
    history: { messages },
  }

  const status = () => (data.session.status(id) === "running" ? "running" : subagentOutcome(info(), messages()))
  const model = createSubagentModelLabel({ info, messages })

  return (
    <>
      <Show
        when={ready()}
        fallback={
          <div class="flex flex-1 items-center justify-center">
            <Show
              when={load.state !== "failed"}
              fallback={
                <p class="text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {language.t("common.requestFailed")}
                </p>
              }
            >
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </Show>
          </div>
        }
      >
        {/* Cards inside this transcript open their subagents in the pane too, and resolve against this session. */}
        <DataContext.Provider
          value={{
            get store() {
              return ui.store
            },
            get directory() {
              return directory()
            },
            get sessionID() {
              return id
            },
            get agents() {
              return ui.agents
            },
            get backgroundCompaction() {
              return ui.backgroundCompaction
            },
            navigateToSession: (child: string) => {
              if (!props.pane.openInPane(child)) ui.navigateToSession?.(child)
            },
            sessionHref: ui.sessionHref,
            readMedia: ui.readMedia,
            peekMedia: ui.peekMedia,
            shellRunning: ui.shellRunning,
            get shellOutput() {
              return ui.shellOutput
            },
            get turnDiff() {
              return ui.turnDiff
            },
          }}
        >
          <PluginLinks session={props.view()} active>
            <div class="relative isolate min-h-0 flex-1 overflow-hidden">
              <MessageTimeline
                active
                hideHeader
                session={source}
                view={props.view()}
                screen={props.screen}
                background={{ blocking: () => [], tasks: () => [], move: () => Promise.resolve() }}
                actions={props.actions({ sessionID: () => id, isChild: () => true })}
                centered={false}
                reserveReviewToggle={false}
                bottomInset={0}
                anchor={(messageID) => `subagent-message-${messageID}`}
                measurementKey={`${server.key}/${id}/subagent-pane`}
                scroll={follow.scroll}
                pinned={follow.pinned()}
                onResumeScroll={follow.resume}
                setScrollRef={follow.setScrollRef}
                onScheduleScrollState={follow.scheduleScrollState}
                onPin={follow.pin}
                onUnpin={follow.unpin}
                onUserScroll={follow.markUserScroll}
                onHistoryScroll={follow.onHistoryScroll}
                onSelectionInteraction={follow.selectionInteraction}
                onContentResize={follow.contentResized}
                setScrollToEnd={follow.setScrollToEnd}
              />
            </div>
          </PluginLinks>
        </DataContext.Provider>
      </Show>
      <Show when={info()}>
        {(session) => (
          <SubagentBar
            agent={session().agent}
            model={model()}
            status={status()}
            started={session().time.created}
            ended={status() === "running" ? undefined : (session().time.idle ?? session().time.updated)}
            stopping={load.stopping}
            onStop={stop}
          />
        )}
      </Show>
    </>
  )
}

// Follows the transcript's end while the reader stays there, and loads older history when they scroll to the top or the
// loaded page does not fill the pane: a reduced copy of the routed timeline's interaction, which also tracks hashes,
// reveals and the composer.
function createSubagentTimelineFollow(input: {
  current: Accessor<boolean>
  ready: Accessor<boolean>
  count: Accessor<number>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadOlder: () => Promise<unknown>
}) {
  const [follow, setFollow] = createStore({ pinned: true, scroll: { overflow: false, jump: false } })
  let scroller: HTMLDivElement | undefined

  let scrollToEnd = (_behavior?: ScrollBehavior) => {}
  let measureFrame: (() => void) | undefined
  let measureTarget: HTMLDivElement | undefined
  let fillFrame: (() => void) | undefined
  let continuationFrame: number | undefined
  let requesting = false

  const unpin = () => {
    if (!scroller || scroller.scrollHeight - scroller.clientHeight <= 1) return
    setFollow("pinned", false)
  }

  // Reads in the shared frame loop's read phase, like the routed timeline.
  const scheduleScrollState = (element: HTMLDivElement) => {
    measureTarget = element

    if (measureFrame !== undefined) return
    let next: { overflow: boolean; jump: boolean } | undefined
    measureFrame = frameLoop.addMeasured(
      () => {
        const target = measureTarget
        measureTarget = undefined

        if (!target) return
        const max = target.scrollHeight - target.clientHeight

        next = { overflow: max > 1, jump: max > 1 && max - target.scrollTop > Math.max(400, target.clientHeight) }
      },
      () => {
        measureFrame = undefined

        if (next && (follow.scroll.overflow !== next.overflow || follow.scroll.jump !== next.jump))
          setFollow("scroll", next)

        return false
      },
    )
  }

  const requestOlder = () => {
    if (requesting || input.loading() || !input.more()) return
    requesting = true
    const before = input.count()
    void input
      .loadOlder()
      .catch(() => undefined)
      .finally(() => {
        requesting = false

        if (!input.current() || input.count() <= before) return
        if (follow.pinned) {
          fill()
          return
        }
        if (scroller && scroller.scrollTop < 200 && input.more() && continuationFrame === undefined) {
          continuationFrame = requestAnimationFrame(() => {
            continuationFrame = undefined
            onHistoryScroll()
          })
        }
      })
  }

  // A page that does not overflow cannot be scrolled up, so it loads the next older page itself.
  const fill = () => {
    if (fillFrame !== undefined) return
    let short = false
    fillFrame = frameLoop.addMeasured(
      () => {
        short =
          input.ready() &&
          follow.pinned &&
          !requesting &&
          !input.loading() &&
          !!scroller &&
          scroller.scrollHeight <= scroller.clientHeight + 1
      },
      () => {
        fillFrame = undefined

        if (short && input.more()) requestOlder()

        return false
      },
    )
  }

  const onHistoryScroll = () => {
    if (follow.pinned || !scroller || scroller.scrollTop >= 200) return
    requestOlder()
  }

  createEffect(
    on(
      () => [input.ready(), follow.pinned] as const,
      ([ready, pinned]) => {
        if (ready && pinned) fill()
      },
    ),
  )

  onCleanup(() => {
    measureFrame?.()
    fillFrame?.()
    if (continuationFrame !== undefined) cancelAnimationFrame(continuationFrame)
  })

  return {
    scroll: follow.scroll,
    pinned: () => follow.pinned,
    pin: () => setFollow("pinned", true),
    unpin,
    fill,
    resume: (behavior?: ScrollBehavior) => {
      setFollow("pinned", true)
      scrollToEnd(behavior)
      if (scroller) scheduleScrollState(scroller)
    },
    setScrollRef: (element: HTMLDivElement | undefined) => {
      scroller = element

      if (!element) return
      scheduleScrollState(element)
      fill()
    },
    setScrollToEnd: (scroll: (behavior?: ScrollBehavior) => void) => {
      scrollToEnd = scroll
    },
    scheduleScrollState,
    contentResized: () => {
      if (!scroller) return
      scheduleScrollState(scroller)
      fill()
    },
    markUserScroll: () => {},
    selectionInteraction: () => {
      if (window.getSelection()?.toString()) unpin()
    },
    onHistoryScroll,
  }
}
