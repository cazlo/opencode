import { createMemo, on, onCleanup, onMount, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { checksum } from "@opencode/util/encode"
import { Icon } from "@opencode/ui/icon"
import { Button } from "@opencode/ui/button"
import { Accordion } from "@opencode/ui/accordion"
import { StickyAccordionHeader } from "@opencode/ui/sticky-accordion-header"
import { showToast } from "@opencode/ui/toast"
import { useI18n } from "@opencode/ui/context/i18n"
import { File } from "@opencode/session-ui/file"
import { Markdown } from "@opencode/session-ui/markdown"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { compactionThreshold, contextPercent, contextTokens, lastAssistantWithUsage } from "@opencode/client/solid"
import { createKeyed, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { catalogModel, syncCatalog } from "./catalog"
import { fetchSessionExport, sessionExportFilename } from "./export"
import { createSessionContextFormatter } from "./format"
import { SessionContextUsageChart } from "./usage-chart"

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 flex-col gap-0.5">
      <div class="truncate text-12-regular text-text-weak">{props.label}</div>
      <div class="truncate text-12-medium text-text-strong tabular-nums">{props.value}</div>
    </div>
  )
}

function RawMessageContent(props: { message: SessionMessageInfo; onRendered: () => void }) {
  const file = createMemo(() => {
    const contents = JSON.stringify(props.message, null, 2)

    return {
      name: `${props.message.type}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: SessionMessageInfo
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.type} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: SessionMessageInfo[] = []

export default function SessionContextTab(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const layout = ctx.layout
  const system = ctx.system
  const i18n = useI18n()
  const data = () => props.session.server.data
  syncCatalog(() => props.session)

  const info = createMemo(() => (props.session.id ? data().session.get(props.session.id) : undefined))

  createKeyed(
    () => {
      const id = props.session.id

      return id && data().session.message.more(id) ? id : undefined
    },
    (id) => {
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      void data()
        .session.message.loadMore(id, { all: true, signal: controller.signal })
        .catch(() => undefined)
    },
  )

  const messages = createMemo(
    () => {
      const id = props.session.id

      if (!id) return emptyMessages

      return data().session.message.list(id)
    },
    emptyMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(i18n.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  // Same step as the TUI and the header button: after the last completed compaction and before an undo boundary.
  const context = createMemo(() => {
    const message = lastAssistantWithUsage(messages(), info()?.revert?.messageID)

    if (!message) return
    const entry = catalogModel(props.session, message.model)
    const total = contextTokens(message.tokens)
    const threshold = compactionThreshold(entry?.model?.limit)

    return {
      message,
      tokens: message.tokens,
      providerLabel: entry?.provider.name ?? message.model.providerID,
      modelLabel: entry?.model?.name ?? message.model.id,
      limit: entry?.model?.limit.context,
      threshold,
      input: message.tokens.input,
      total,
      // Measured against the compaction threshold, the point where usage actually runs out.
      usage: contextPercent(total, threshold) ?? null,
    }
  })

  const fallbackModel = createMemo(() => {
    const c = context()

    if (c) {
      return {
        limit: c.limit,
        threshold: c.threshold,
      }
    }

    const ref = info()?.model ?? messages().findLast((item) => item.type === "assistant")?.model

    if (!ref) return

    const entry = catalogModel(props.session, ref)

    return {
      limit: entry?.model?.limit.context,
      threshold: compactionThreshold(entry?.model?.limit),
    }
  })

  const formatter = createMemo(() => createSessionContextFormatter(i18n.locale()))

  // A root session's cost includes its subagent sessions, as in the TUI.
  const cost = createMemo(() => usd().format(props.session.id ? data().session.cost(props.session.id) : 0))

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, message) => count + (message.type === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, message) => count + (message.type === "assistant" ? 1 : 0), 0)

    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const system = messages().findLast((message) => message.type === "system")?.text

    if (!system) return
    const trimmed = system.trim()

    if (!trimmed) return

    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = context()

    if (!c) return "—"

    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = context()

    if (!c) return "—"

    return c.modelLabel
  })

  const lastActivityTime = createMemo(
    () => context()?.message.time.completed ?? context()?.message.time.created ?? info()?.time.updated,
  )

  const stats = [
    { label: "stats.usage", value: () => formatter().percent(context()?.usage) },
    { label: "stats.totalTokens", value: () => formatter().number(context()?.total) },
    { label: "stats.compactionThreshold", value: () => formatter().number(fallbackModel()?.threshold) },
    { label: "stats.limit", value: () => formatter().number(fallbackModel()?.limit) },
    { label: "stats.totalCost", value: cost },
    { label: "stats.sessionDuration", value: () => formatter().duration(info()?.time.created, lastActivityTime()) },
    { label: "stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "stats.lastActivity", value: () => formatter().time(lastActivityTime()) },
    { label: "stats.inputTokens", value: () => formatter().number(context()?.input) },
    { label: "stats.outputTokens", value: () => formatter().number(context()?.tokens.output) },
    { label: "stats.reasoningTokens", value: () => formatter().number(context()?.tokens.reasoning) },
    {
      label: "stats.cacheTokens",
      value: () =>
        `${formatter().number(context()?.tokens.cache.read)} / ${formatter().number(context()?.tokens.cache.write)}`,
    },
    { label: "stats.messages", value: () => counts().all.toLocaleString(i18n.locale()) },
    { label: "stats.userMessages", value: () => counts().user.toLocaleString(i18n.locale()) },
    { label: "stats.assistantMessages", value: () => counts().assistant.toLocaleString(i18n.locale()) },
    { label: "stats.provider", value: providerLabel },
    { label: "stats.model", value: modelLabel },
    { label: "stats.session", value: () => info()?.title ?? (props.session.id || "—") },
  ] satisfies { label: string; value: () => JSX.Element }[]

  const exportSession = async () => {
    const sessionID = props.session.id

    if (!sessionID) return

    try {
      const data = await fetchSessionExport({
        sessionID,
        api: props.session.server.client,
      })

      const filename = sessionExportFilename(data.info)

      if (!(await system.save({ name: filename, content: JSON.stringify(data, null, 2) }))) return
      showToast({
        variant: "success",
        // Solid resolves JSX accessors under the toast's render owner, not this imperative call site.
        icon: () => <Icon name="circle-check" />,
        title: ctx.t("export.success.title"),
        description: ctx.t("export.success.description", { filename }),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: ctx.t("export.failed.title"),
        description: err instanceof Error ? err.message : ctx.t("export.failed.description"),
      })
    }
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll

    if (!el) return

    const s = layout.scroll.get(props.session, "context")

    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y

    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }

    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined

      if (!next) return

      layout.scroll.set(props.session, "context", next)
    })
  }

  // Restores the stored scroll a frame after the messages change; on mount the viewport ref restores it.
  createKeyed(
    createMemo(on(messages, (list) => list, { defer: true })),
    () => void requestAnimationFrame(restoreScroll),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <div
      class="@container h-full overflow-y-auto"
      data-scrollable
      ref={(el) => {
        scroll = el
        // The ref runs before the content renders into the element.
        onMount(restoreScroll)
      }}
      onScroll={handleScroll}
    >
      <div data-slot="session-usage-content" class="px-4 pt-4 pb-6 flex flex-col gap-5 md:px-6 md:pb-10 md:gap-6">
        <SessionContextUsageChart
          messages={messages()}
          revertMessageID={info()?.revert?.messageID}
          limit={fallbackModel()?.limit}
          threshold={fallbackModel()?.threshold}
          formatTokens={formatter().compactTokens}
          formatPercent={formatter().percent}
          formatTime={formatter().time}
          labels={{
            title: ctx.t("chart.title"),
            empty: ctx.t("chart.empty"),
            header: (input) => ctx.t("chart.header", input),
            usage: (input) => ctx.t(input.ceiling && input.percent ? "chart.usage" : "chart.usage.tokens", input),
            threshold: (input) => ctx.t(input.percent ? "chart.threshold" : "chart.threshold.tokens", input),
            compacted: (count) => ctx.plural("chart.compacted", count),
            limit: (input) => ctx.t("chart.limit", input),
          }}
        />

        <div class="grid grid-cols-2 @[20rem]:grid-cols-3 @[28rem]:grid-cols-4 gap-x-3 gap-y-2.5">
          <For each={stats}>{(stat) => <Stat label={ctx.t(stat.label)} value={stat.value()} />}</For>
        </div>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{ctx.t("systemPrompt.title")}</div>
              <div class="border border-v2-border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <div class="text-12-regular text-text-weak">{ctx.t("rawMessages.title")}</div>
            <Button
              size="small"
              variant="ghost"
              class="gap-1.5 px-2 text-text-weak hover:text-text-base"
              onClick={exportSession}
            >
              <Icon name="download" size="small" />
              <span>{ctx.t("export.session")}</span>
            </Button>
          </div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => <RawMessage message={message} onRendered={restoreScroll} time={formatter().time} />}
            </For>
          </Accordion>
        </div>
      </div>
    </div>
  )
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true

  if (!a || !b) return false

  if (a.length !== b.length) return false

  return a.every((x, i) => x === b[i])
}
