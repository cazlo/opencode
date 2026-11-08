import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Slash } from "@opencode/ui/slash"
import { Tooltip } from "@opencode/ui/tooltip"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { formatKeybind } from "@/shell/commands/command"
import { formatElapsed } from "./activity-chips"

export type SubagentStatus = "running" | "succeeded" | "failed" | "interrupted"

// A subagent session takes no prompts, so its composer slot is one quiet status line on the timeline's own surface:
// the run's state, agent, model and variant, max context use and duration, and the way back.
export function SubagentBar(props: {
  agent?: string
  model?: { provider?: string; name: string; variant?: string }
  status?: SubagentStatus
  contextPercent?: number
  started: number
  ended?: number
  stopping?: boolean
  onStop?: () => void
  /** Without it the bar has no way back, as in a subagent's side tab. */
  onBack?: () => void
}) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())

  const percentFormat = createMemo(
    () => new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 0 }),
  )

  // Only what is known shows, with one separator between neighbours.
  const parts = () => [
    ...(props.status ? (["status"] as const) : []),
    ...(props.agent ? (["agent"] as const) : []),
    ...(props.model ? (["model"] as const) : []),
    ...(props.contextPercent !== undefined ? (["context"] as const) : []),
    "elapsed" as const,
  ]

  createEffect(() => {
    if (props.ended !== undefined && props.status !== "running") return

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    // The timeline scrolls on underneath, so the line keeps its surface and fades the text passing into it.
    <div
      data-component="subagent-bar"
      class="relative flex min-h-8 w-full min-w-0 items-center gap-2 bg-v2-background-bg-base py-1.5 ps-3 pe-1.5 text-[12px] font-[440] leading-[var(--line-height-compact)] tracking-[-0.04px] whitespace-nowrap tabular-nums text-v2-text-text-faint before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-[linear-gradient(to_top,var(--v2-background-bg-base),transparent)]"
    >
      <Show when={props.status}>{(status) => <SubagentStatusIcon status={status()} />}</Show>
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
        <For each={parts()}>
          {(part, index) => (
            <span class="flex shrink-0 items-center gap-1.5">
              <Show when={index() > 0}>
                <span aria-hidden="true">·</span>
              </Show>
              <Switch>
                <Match when={part === "status" && props.status}>
                  {(status) => <span class="shrink-0">{language.t(`session.child.status.${status()}`)}</span>}
                </Match>
                <Match when={part === "agent" && props.agent}>
                  {(agent) => <span class="shrink-0 capitalize">{agent()}</span>}
                </Match>
                <Match when={part === "model" && props.model}>
                  {(model) => (
                    <span data-slot="subagent-model" class="flex shrink-0 items-center">
                      <Show when={model().provider}>
                        <span class="shrink-0">{model().provider}</span>
                        <Slash gap={4} />
                        <span class="sr-only">{" / "}</span>
                      </Show>
                      <span class="shrink-0">{model().name}</span>
                      {/* Like the message metadata: the variant follows the name, dimmer, with no separator. */}
                      <Show when={model().variant !== "default" && model().variant}>
                        {(variant) => (
                          <>
                            <span class="sr-only"> </span>
                            <span class="ms-1 shrink-0 capitalize opacity-[0.66]">{variant()}</span>
                          </>
                        )}
                      </Show>
                    </span>
                  )}
                </Match>
                <Match when={part === "context" && props.contextPercent !== undefined}>
                  <span data-slot="subagent-context" class="flex shrink-0 items-center gap-1 text-v2-text-text-muted">
                    <span aria-hidden="true" class="flex shrink-0 items-center">
                      <ProgressCircle percentage={props.contextPercent ?? 0} size={12} />
                    </span>
                    <span>{percentFormat().format((props.contextPercent ?? 0) / 100)}</span>
                  </span>
                </Match>
                <Match when={part === "elapsed"}>
                  <span data-slot="subagent-elapsed" class="shrink-0 text-v2-text-text-muted">
                    {formatElapsed((props.ended ?? now()) - props.started, language.t)}
                  </span>
                </Match>
              </Switch>
            </span>
          )}
        </For>
      </div>
      <Show when={props.status === "running" ? props.onStop : undefined}>
        {(onStop) => (
          <Tooltip placement="top" value={language.t("session.running.stop.subagent")}>
            <IconButton
              type="button"
              variant="ghost-muted"
              size="small"
              class="shrink-0"
              disabled={props.stopping}
              icon={<Icon name="stop" size="small" />}
              aria-label={language.t("session.running.stop.subagent")}
              onClick={onStop()}
            />
          </Tooltip>
        )}
      </Show>
      <Show when={props.onBack}>
        {(onBack) => (
          <Button type="button" variant="ghost-faint" size="small" class="shrink-0 gap-1.5 px-1.5" onClick={onBack()}>
            {language.t("session.child.backToParent")}
            <span class="hidden sm:block">
              <Keybind keys={[formatKeybind("esc", language.t)]} variant="neutral" />
            </span>
          </Button>
        )}
      </Show>
    </div>
  )
}

export function SubagentStatusIcon(props: { status: SubagentStatus }) {
  return (
    <span
      class="flex size-4 shrink-0 items-center justify-center"
      classList={{
        "text-v2-state-fg-danger": props.status === "failed" || props.status === "interrupted",
        "text-v2-icon-icon-faint": props.status !== "failed" && props.status !== "interrupted",
      }}
    >
      <Switch>
        <Match when={props.status === "running"}>
          <SessionProgressIndicatorV2 />
        </Match>
        <Match when={props.status === "succeeded"}>
          <Icon name="check" size="small" />
        </Match>
        <Match when={props.status === "failed"}>
          <Icon name="circle-xmark" size="small" />
        </Match>
        <Match when={props.status === "interrupted"}>
          <Icon name="outline-xmark" size="small" />
        </Match>
      </Switch>
    </span>
  )
}
