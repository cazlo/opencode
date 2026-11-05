import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  on,
  onCleanup,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { MountedSession, SessionScreen } from "@opencode/plugin/gui"
import type { SessionSubagents } from "@opencode/plugin/gui/builtin"
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
import { SubagentBar, SubagentStatusIcon, type SubagentStatus } from "@/session/composer/subagent-bar"
import type { TimelineActionsView } from "@/session/composer/timeline-actions"
import type { SessionModel } from "@/session/model"
import { sessionTitle } from "@/session/title"
import type { TimelineSessionSource } from "@/session/timeline/controller"
import { MessageTimeline } from "@/session/timeline/message-timeline"
import { PluginLinks } from "@/runtime/plugin/render"
import { enrichLeadingTurn, leadingTurnPageDelay, leadingTurnPageLimit } from "@/session/timeline/model"
import { createTimelineFollow } from "@/session/timeline/follow"
import {
  canRequestFillProbe,
  canRequestScrollPage,
  createTimelineHistoryState,
  DISPOSED_HISTORY_EVENT,
  FILL_REQUESTED_EVENT,
  HISTORY_LOAD_TIMEOUT_MS,
  HISTORY_RETRY_COOLDOWN_MS,
  HISTORY_SCROLL_THRESHOLD,
  SCROLL_TOP_EVENT,
  transitionTimelineHistory,
  type TimelineHistoryEffect,
  type TimelineHistoryEvent,
} from "@/session/timeline/history-machine"
import { createSubagentGroups, type SessionSubagentsModel } from "./controller"
import { createSubagentModelLabel } from "./model-label"
import { SubagentHeader, SubagentList } from "./pane"
import { subagentEnded, subagentOutcome } from "./tree"

// The routed session's subagents as the session screen draws them for a side panel: the list of them, any one's live,
// read-only transcript, and the status mark a tab shows.
export function createSubagentsView(input: {
  model: SessionSubagentsModel
  session: SessionModel
  view: Accessor<MountedSession>
  screen: SessionScreen
  actions: (view: TimelineActionsView) => SessionUserActions
}): SessionSubagents {
  const data = useServer().ctx.data

  const status = (id: string): SubagentStatus | undefined =>
    data.session.status(id) === "running"
      ? "running"
      : subagentOutcome(data.session.get(id), data.session.message.list(id))

  return {
    List: () => {
      const groups = createSubagentGroups(() => input.session.identity.params.id)

      return (
        <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden pt-1">
          <SubagentList groups={groups} onSelect={(id) => input.model.open(id)} />
        </div>
      )
    },
    Transcript: (props) => {
      const language = useLanguage()
      // A tab renders once for its subagent.
      const id = untrack(() => props.id)

      return (
        <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <SubagentHeader
            title={sessionTitle(data.session.get(id)?.title) ?? language.t("session.tab.session")}
            onOpenFull={() => {
              props.onOpenFull?.()
              input.model.openFull(id)
            }}
          />
          <ErrorBoundary
            fallback={
              <p class="m-auto text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                {language.t("common.requestFailed")}
              </p>
            }
          >
            <SubagentTranscript
              id={id}
              model={input.model}
              session={input.session}
              view={input.view}
              screen={input.screen}
              actions={input.actions}
            />
          </ErrorBoundary>
        </div>
      )
    },
    Status: (props) => <Show when={status(props.id)}>{(value) => <SubagentStatusIcon status={value()} />}</Show>,
    title: (id) => sessionTitle(input.model.title(id)),
    state: input.model.state,
  }
}

function SubagentTranscript(props: {
  id: string
  model: SessionSubagentsModel
  session: SessionModel
  view: Accessor<MountedSession>
  screen: SessionScreen
  actions: (view: TimelineActionsView) => SessionUserActions
}) {
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

  // Mirrors the routed session's key, so what the timeline stores about this subagent belongs to its own route.
  const sessionKey = createMemo(() =>
    SessionStateKey.from(serverSDK.scope, SessionRouteKey.fromRoute(base64Encode(directory()), id)),
  )

  const interaction = createSubagentTimelineInteraction({
    sessionKey,
    sessionID: id,
    ready,
    more,
    oldest: createMemo(() => messages()[0]?.id),
    loadMore: (signal) => data.session.message.loadMore(id, { signal }),
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
        {/* Cards inside this transcript open their subagents in tabs too, and resolve against this session. */}
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
              if (!props.model.open(child)) ui.navigateToSession?.(child)
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
                measurementKey={`${server.key}/${id}/subagent-tab`}
                scroll={interaction.scroll}
                onResumeScroll={interaction.resume}
                setScrollRef={interaction.setScrollRef}
                onScheduleScrollState={interaction.scheduleScrollState}
                follow={interaction.follow}
                onUserScroll={interaction.markUserScroll}
                onHistoryScroll={interaction.onHistoryScroll}
                onContentResize={interaction.contentResized}
                setScrollToEnd={interaction.setScrollToEnd}
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
            ended={status() === "running" ? undefined : subagentEnded(session(), messages())}
            stopping={load.stopping}
            onStop={stop}
          />
        )}
      </Show>
    </>
  )
}

// Follows the transcript's end while the reader stays there, and loads older history when they scroll near the top or
// the loaded page does not fill the tab: the routed timeline's follow and history machines, without its prompt cursor,
// hash reveals and composer inset.
function createSubagentTimelineInteraction(input: {
  sessionKey: Accessor<string>
  sessionID: string
  ready: Accessor<boolean>
  more: Accessor<boolean>
  oldest: Accessor<string | undefined>
  loadMore: (signal: AbortSignal) => Promise<void>
}) {
  const [scroll, setScroll] = createStore({ overflow: false, jump: false })
  const follow = createTimelineFollow(input.sessionKey)
  const [history, setHistory] = createSignal(createTimelineHistoryState())
  let scroller: HTMLDivElement | undefined
  let scrollToEnd = (_behavior?: ScrollBehavior) => {}

  let measureFrame: (() => void) | undefined
  let measureTarget: HTMLDivElement | undefined
  let resumeFrame: (() => void) | undefined
  let probe: (() => void) | undefined
  let load: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | undefined
  let cooldown: ReturnType<typeof setTimeout> | undefined

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

        if (next && (scroll.overflow !== next.overflow || scroll.jump !== next.jump)) setScroll(next)

        return false
      },
    )
  }

  // Runs inside the virtualizer's ref and resize effects, so it reads untracked: they must not rerun on each phase.
  const requestFill = () => {
    if (!canRequestFillProbe(untrack(history)) || !untrack(follow.following)) return
    dispatch(FILL_REQUESTED_EVENT)
  }

  function dispatch(event: TimelineHistoryEvent) {
    untrack(() => {
      const current = history()
      const next = transitionTimelineHistory(current, event)

      if (next.state !== current) setHistory(next.state)
      next.effects.forEach(run)
    })
  }

  function run(effect: TimelineHistoryEffect) {
    if (effect.type === "probe.schedule") {
      probe?.()
      let more = false
      probe = frameLoop.addMeasured(
        () => {
          more =
            !!scroller &&
            (effect.probe === "fill"
              ? follow.following() && scroller.scrollHeight <= scroller.clientHeight + 1
              : !follow.following() && scroller.scrollTop < HISTORY_SCROLL_THRESHOLD)
        },
        () => {
          probe = undefined
          dispatch({ type: "probe.settled", attempt: effect.attempt, load: more })

          return false
        },
      )

      return
    }

    if (effect.type === "probe.cancel") {
      probe?.()
      probe = undefined

      return
    }

    if (effect.type === "load.start") {
      abortLoad()
      const previous = input.oldest()

      const page = {
        controller: new AbortController(),
        timer: setTimeout(() => dispatch({ type: "page.timed-out", attempt: effect.attempt }), HISTORY_LOAD_TIMEOUT_MS),
      }

      // Every outcome settles in the machine, which drops a result whose attempt is no longer current.
      const settle = (event: TimelineHistoryEvent) => {
        clearTimeout(page.timer)

        if (load === page) load = undefined
        dispatch(event)
      }

      load = page
      input.loadMore(page.controller.signal).then(
        () =>
          settle({
            type: "page.loaded",
            attempt: effect.attempt,
            previous,
            oldest: input.oldest(),
            more: input.more(),
            following: follow.following(),
          }),
        () => settle({ type: "page.failed", attempt: effect.attempt }),
      )

      return
    }

    if (effect.type === "load.abort") {
      abortLoad()

      return
    }

    clearTimeout(cooldown)
    cooldown = undefined

    if (effect.type === "cooldown.cancel") return
    cooldown = setTimeout(() => {
      cooldown = undefined
      dispatch({ type: "cooldown.settled", attempt: effect.attempt, following: follow.following() })
    }, HISTORY_RETRY_COOLDOWN_MS)
  }

  function abortLoad() {
    if (!load) return
    clearTimeout(load.timer)
    load.controller.abort()
    load = undefined
  }

  createEffect(() =>
    dispatch({
      type: "sync",
      target: { sessionKey: input.sessionKey(), sessionID: input.sessionID },
      ready: input.ready(),
      more: input.more(),
      following: follow.following(),
      oldest: input.oldest(),
    }),
  )

  onCleanup(() => {
    dispatch(DISPOSED_HISTORY_EVENT)
    resumeFrame?.()
    measureFrame?.()
  })

  return {
    scroll,
    follow,
    scheduleScrollState,
    // Scrolls on the next frame, as the routed timeline does; input that stops following meanwhile drops the attempt.
    resume: (behavior?: ScrollBehavior) => {
      const attempt = follow.beginReturn()

      resumeFrame?.()
      resumeFrame = frameLoop.add(() => {
        resumeFrame = undefined
        const before = follow.peek()
        follow.dispatch({ type: "return.run", attempt })

        if (follow.peek() !== before) scrollToEnd(behavior)

        return false
      })

      if (scroller) scheduleScrollState(scroller)
    },
    setScrollRef: (element: HTMLDivElement | undefined) => {
      scroller = element

      if (!element) return
      scheduleScrollState(element)
      requestFill()
    },
    setScrollToEnd: (scrollTo: (behavior?: ScrollBehavior) => void) => {
      scrollToEnd = scrollTo
    },
    contentResized: () => {
      if (scroller) scheduleScrollState(scroller)
      requestFill()
    },
    // The routed timeline uses gestures to drop its prompt cursor, which this view has none of.
    markUserScroll: () => {},
    onHistoryScroll: () => {
      if (
        !scroller ||
        scroller.scrollTop >= HISTORY_SCROLL_THRESHOLD ||
        !canRequestScrollPage(untrack(history)) ||
        untrack(follow.following)
      )
        return
      dispatch(SCROLL_TOP_EVENT)
    },
  }
}
