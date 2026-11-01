import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { SessionHeaderSpacer } from "@/session/header/session-header"
import { formatElapsed } from "@/session/composer/activity-chips"
import { SubagentStatusIcon } from "@/session/composer/subagent-bar"
import { sessionTitle } from "@/session/title"
import type { SubagentRow } from "./tree"

export function SubagentPaneToggle(props: { opened: boolean; onToggle: () => void }) {
  const command = useCommand()
  const language = useLanguage()
  const keys = () => command.keybindParts("session.subagents.toggle")

  return (
    <Tooltip
      class="shrink-0"
      placement="bottom"
      value={
        <>
          {language.t("command.session.subagents.toggle")}
          <Show when={keys().length > 0}>
            <Keybind keys={keys()} variant="neutral" />
          </Show>
        </>
      }
    >
      <IconButton
        type="button"
        variant="ghost-muted"
        size="large"
        class="shrink-0"
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onToggle}
        aria-label={language.t("command.session.subagents.toggle")}
        aria-expanded={props.opened}
        aria-controls="subagent-pane"
        icon={<Icon name="branch-out" />}
      />
    </Tooltip>
  )
}

export function SubagentPaneFrame(
  props: ParentProps<{
    title: string
    onBack?: () => void
    onOpenFull?: () => void
    onClose: () => void
    autoFocusBack?: boolean
    onAutoFocus?: () => void
    /** The floating review toggle sits over this header's end. */
    reserveReviewToggle?: boolean
  }>,
) {
  const language = useLanguage()
  let back: HTMLButtonElement | undefined

  // Opening a subagent moves focus into its view, from the row or card that was activated.
  onMount(() => {
    if (!props.autoFocusBack) return
    props.onAutoFocus?.()
    if (!editable(document.activeElement)) back?.focus()
  })

  return (
    <>
      <header class="flex h-12 shrink-0 items-center gap-1 ps-2 pe-3">
        <Show when={props.onBack}>
          {(onBack) => (
            <Tooltip placement="bottom" value={language.t("session.subagents.back")}>
              <IconButton
                ref={back}
                type="button"
                variant="ghost-muted"
                size="large"
                class="shrink-0"
                icon={<Icon name="outline-arrow-left" />}
                aria-label={language.t("session.subagents.back")}
                onClick={onBack()}
              />
            </Tooltip>
          )}
        </Show>
        <h2 class="min-w-0 flex-1 truncate px-1 text-[13px] font-[530] leading-[var(--line-height-compact)] tracking-[-0.04px] text-v2-text-text-base">
          <bdi dir="auto">{props.title}</bdi>
        </h2>
        <Show when={props.onOpenFull}>
          {(onOpenFull) => (
            <Tooltip placement="bottom" value={language.t("session.subagents.openFull")}>
              <IconButton
                type="button"
                variant="ghost-muted"
                size="large"
                class="shrink-0"
                icon={<Icon name="outline-arrow-up-right" />}
                aria-label={language.t("session.subagents.openFull")}
                onClick={onOpenFull()}
              />
            </Tooltip>
          )}
        </Show>
        <Tooltip placement="bottom" value={language.t("session.subagents.close")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="large"
            class="shrink-0"
            icon={<Icon name="close" />}
            aria-label={language.t("session.subagents.close")}
            onClick={props.onClose}
          />
        </Tooltip>
        <SessionHeaderSpacer visible={props.reserveReviewToggle === true} />
      </header>
      <div class="relative flex min-h-0 flex-1 flex-col">{props.children}</div>
    </>
  )
}

export function SubagentList(props: {
  groups: { running: readonly SubagentRow[]; completed: readonly SubagentRow[] }
  onSelect: (id: string) => void
  /** The subagent whose view was just left; its row takes focus. */
  focus?: string
  onAutoFocus?: () => void
}) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())
  const rows = new Map<string, HTMLButtonElement>()

  const percentFormat = createMemo(
    () => new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 0 }),
  )

  onMount(() => {
    if (!props.focus) return
    const id = props.focus
    props.onAutoFocus?.()
    if (!editable(document.activeElement)) rows.get(id)?.focus()
  })

  // One clock for every row, ticking only while something runs.
  createEffect(() => {
    if (!props.groups.running.some((row) => row.ended === undefined)) return

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const sections = () =>
    [
      { title: language.t("session.subagents.running"), rows: props.groups.running },
      { title: language.t("session.subagents.completed"), rows: props.groups.completed },
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
                <h3 class="px-2 pb-1 pt-3 text-[12px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-faint">
                  {section.title}
                </h3>
                <ul>
                  <For each={section.rows}>
                    {(row) => (
                      <li>
                        <button
                          ref={(element) => {
                            rows.set(row.id, element)
                            onCleanup(() => rows.delete(row.id))
                          }}
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

function editable(node: Element | null) {
  return node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName))
}
