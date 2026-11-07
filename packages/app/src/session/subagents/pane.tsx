import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { formatElapsed } from "@/session/composer/activity-chips"
import { SubagentStatusIcon } from "@/session/composer/subagent-bar"
import { sessionTitle } from "@/session/title"
import type { SubagentRow } from "./tree"

// A subagent tab's header: its full title, which the tab's label truncates, and the way to its own session.
export function SubagentHeader(props: { title: string; onOpenFull: () => void }) {
  const language = useLanguage()

  return (
    <header class="flex h-10 shrink-0 items-center gap-1 ps-3 pe-2">
      <h2 class="min-w-0 flex-1 truncate text-[13px] font-[530] leading-[var(--line-height-compact)] tracking-[-0.04px] text-v2-text-text-base">
        <bdi dir="auto">{props.title}</bdi>
      </h2>
      <Tooltip placement="bottom" value={language.t("session.subagents.openFull")}>
        <IconButton
          type="button"
          variant="ghost-muted"
          size="large"
          class="shrink-0"
          icon={<Icon name="outline-arrow-up-right" />}
          aria-label={language.t("session.subagents.openFull")}
          onClick={props.onOpenFull}
        />
      </Tooltip>
    </header>
  )
}

export function SubagentList(props: {
  groups: { running: readonly SubagentRow[]; completed: readonly SubagentRow[] }
  onSelect: (id: string) => void
}) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())

  const percentFormat = createMemo(
    () => new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 0 }),
  )

  // One clock for every row, ticking only while something runs.
  createEffect(() => {
    if (!props.groups.running.some((row) => row.ended === undefined)) return

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const sections = () =>
    [
      {
        title: language.plural("session.subagents.running", props.groups.running.length),
        rows: props.groups.running,
      },
      {
        title: language.plural("session.subagents.completed", props.groups.completed.length),
        rows: props.groups.completed,
      },
    ] as const

  return (
    <Show
      when={props.groups.running.length + props.groups.completed.length > 0}
      fallback={
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-[13px] leading-[var(--line-height-compact)]">
          <p class="text-v2-text-text-base">{language.t("session.subagents.empty")}</p>
          <p class="text-v2-text-text-muted">{language.t("session.subagents.empty.description")}</p>
        </div>
      }
    >
      <div data-scrollable class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <For each={sections()}>
          {(section) => (
            <Show when={section.rows.length > 0}>
              <section>
                <h3 class="px-2 pb-1 pt-3 text-[12px] font-medium leading-[var(--line-height-compact)] tabular-nums text-v2-text-text-faint">
                  {section.title}
                </h3>
                <ul>
                  <For each={section.rows}>
                    {(row) => (
                      <li>
                        <button
                          type="button"
                          class="flex h-11 w-full min-w-0 flex-col justify-center gap-0.5 rounded-[6px] pe-2 text-start leading-[var(--line-height-compact)] hover:bg-v2-overlay-simple-overlay-hover"
                          style={{ "padding-inline-start": `${8 + Math.min(row.depth, 4) * 16}px` }}
                          onClick={() => props.onSelect(row.id)}
                        >
                          <span class="flex w-full min-w-0 items-center gap-2 text-[13px] font-[440] text-v2-text-text-base">
                            <Show when={row.status} fallback={<span class="size-4 shrink-0" aria-hidden="true" />}>
                              {(status) => (
                                <>
                                  <SubagentStatusIcon status={status()} />
                                  <span class="sr-only">{language.t(`session.child.status.${status()}`)}</span>
                                </>
                              )}
                            </Show>
                            <span class="min-w-0 flex-1 truncate">
                              <bdi dir="auto">{sessionTitle(row.title) ?? language.t("session.tab.session")}</bdi>
                            </span>
                          </span>
                          <span class="flex w-full min-w-0 items-center gap-1.5 ps-6 text-[12px] font-[440] tabular-nums text-v2-text-text-faint">
                            <Show when={row.agent}>
                              {(agent) => (
                                <>
                                  <span class="min-w-0 truncate capitalize">{agent()}</span>
                                  <span aria-hidden="true" class="shrink-0">
                                    ·
                                  </span>
                                </>
                              )}
                            </Show>
                            <Show when={row.contextPercent !== undefined}>
                              <>
                                <span class="flex shrink-0 items-center gap-1 text-v2-text-text-muted">
                                  <span aria-hidden="true" class="flex shrink-0 items-center">
                                    <ProgressCircle percentage={row.contextPercent ?? 0} size={12} />
                                  </span>
                                  <span>{percentFormat().format((row.contextPercent ?? 0) / 100)}</span>
                                </span>
                                <span aria-hidden="true" class="shrink-0">
                                  ·
                                </span>
                              </>
                            </Show>
                            <span class="shrink-0 text-v2-text-text-muted">
                              {formatElapsed((row.ended ?? now()) - row.started, language.t)}
                            </span>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}
