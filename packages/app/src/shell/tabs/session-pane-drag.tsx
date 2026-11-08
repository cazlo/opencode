import { createContext, createMemo, createSignal, onCleanup, onMount, Show, untrack, useContext, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { ServerConnection } from "@/runtime/server/registry"
import { tabKey, useTabs } from "./tabs"
import {
  INITIAL_SESSION_PANE_DRAG_STATE,
  resolveSessionPaneBodyDrop,
  selectSessionDraggingKey,
  selectSessionDragLayer,
  selectSessionMoveKey,
  transitionSessionPaneDrag,
  type Rect,
  type SessionPaneDragEffect,
  type SessionPaneDragEvent,
  type SessionPaneDragState,
  type SessionPaneDropTarget,
} from "./session-pane-drag-machine"

function createSessionPaneDragService() {
    const tabs = useTabs()
    const [dragState, setDragState] = createSignal<SessionPaneDragState>(INITIAL_SESSION_PANE_DRAG_STATE)
    const dragging = createMemo(() => selectSessionDraggingKey(dragState()))
    const layer = createMemo(() => selectSessionDragLayer(dragState()))
    const [droppedRecently, setDroppedRecently] = createSignal(false)

    let clearSuppression: (() => void) | undefined
    let clearDropFlagTimer: ReturnType<typeof setTimeout> | undefined
    let sidebarSessionSource: { key: string; server: ServerConnection.Key; sessionId: string } | undefined
    let cancellingDnd = false
    let dndCancelled = false

    const inside = (rect: DOMRect, x: number, y: number) =>
      rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

    const hit = (x: number, y: number, key: string): SessionPaneDropTarget | undefined => {
      const currentPreview = tabs.preview()

      const isOpen =
        tabs.store.some((item) => tabKey(item) === key) ||
        (currentPreview ? tabKey(currentPreview) === key : false)

      const sourcePaneId = isOpen ? tabs.split.tabPane(key) : undefined

      const strip = Array.from(document.querySelectorAll<HTMLElement>("[data-session-pane-strip]")).find((element) =>
        inside(visibleRect(element), x, y),
      )

      const stripPaneId = strip?.dataset.sessionPaneStrip

      if (strip && stripPaneId) {
        if (isOpen && stripPaneId === sourcePaneId) return undefined

        const slotElements = Array.from(
          strip.querySelectorAll<HTMLElement>("[data-titlebar-tab-slot][data-tab-key]"),
        ).filter((element) => element.dataset.tabKey !== key)

        const next = slotElements.find((element) => {
          const rect = element.getBoundingClientRect()

          return x < rect.left + rect.width / 2
        })

        const anchor = (next ?? slotElements.at(-1))?.getBoundingClientRect()
        const bounds = visibleRect(strip)

        return {
          kind: "strip",
          paneId: stripPaneId,
          before: next?.dataset.tabKey,
          rect: anchor
            ? {
                left: Math.min(Math.max((next ? anchor.left : anchor.right) - 1, bounds.left), bounds.right - 2),
                top: anchor.top + 2,
                width: 2,
                height: anchor.height - 4,
              }
            : { left: bounds.left + 12, top: bounds.top + 6, width: 2, height: Math.max(16, bounds.height - 12) },
        }
      }

      const body = Array.from(document.querySelectorAll<HTMLElement>("[data-session-pane-body]")).find((element) =>
        inside(element.getBoundingClientRect(), x, y),
      )

      const paneId = body?.dataset.sessionPaneBody

      if (!body || !paneId) return undefined

      return resolveSessionPaneBodyDrop({
        x,
        y,
        rect: toRect(body.getBoundingClientRect()),
        paneId,
        sourcePaneId,
        canSplit: tabs.split.canSplitWithTab(key, paneId),
      })
    }

    const dispatch = (event: SessionPaneDragEvent) => {
      const previous = untrack(dragState)
      const next = transitionSessionPaneDrag(previous, event)

      if (next.state === previous) return false
      setDragState(next.state)
      next.effects.forEach(runEffect)

      return true
    }

    const move = (event: PointerEvent) => {
      const key = selectSessionMoveKey(untrack(dragState), event.pointerId, event.clientX, event.clientY)

      if (key === undefined) return
      const target = hit(event.clientX, event.clientY, key)

      if (target && !dndCancelled) {
        dndCancelled = true
        cancellingDnd = true
        document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: event.pointerId, bubbles: true }))
        cancellingDnd = false
      }

      dispatch({
        type: "pointer.move",
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target,
      })
    }

    const up = (event: PointerEvent) => {
      const current = untrack(dragState)

      if (current.status === "dragging" && current.target) {
        event.preventDefault()
        event.stopPropagation()
      }

      dispatch({ type: "pointer.up", pointerId: event.pointerId })
    }

    const cancel = (event: PointerEvent) => {
      if (cancellingDnd) return
      dispatch({ type: "pointer.cancel", pointerId: event.pointerId })
    }

    const blur = () => dispatch({ type: "blur" })

    const escape = (keyboard: KeyboardEvent) => {
      if (keyboard.key !== "Escape" || !dispatch({ type: "escape" })) return
      keyboard.preventDefault()
      keyboard.stopPropagation()
    }

    const swallow = (click: MouseEvent) => {
      click.preventDefault()
      click.stopPropagation()
    }

    const markDropped = () => {
      setDroppedRecently(true)

      if (clearDropFlagTimer !== undefined) clearTimeout(clearDropFlagTimer)
      clearDropFlagTimer = setTimeout(() => {
        clearDropFlagTimer = undefined
        setDroppedRecently(false)
      }, 100)
    }

    const runEffect = (effect: SessionPaneDragEffect) => {
      if (effect.type === "gesture.attach") {
        dndCancelled = false
        window.addEventListener("pointermove", move, true)
        window.addEventListener("pointerup", up, true)
        window.addEventListener("pointercancel", cancel, true)
        window.addEventListener("blur", blur)
        window.addEventListener("keydown", escape, true)

        return
      }

      if (effect.type === "gesture.cleanup") {
        dndCancelled = false
        window.removeEventListener("pointermove", move, true)
        window.removeEventListener("pointerup", up, true)
        window.removeEventListener("pointercancel", cancel, true)
        window.removeEventListener("blur", blur)
        window.removeEventListener("keydown", escape, true)

        if (!effect.unlockBody) return
        document.body.style.userSelect = ""
        document.body.style.cursor = ""

        return
      }

      if (effect.type === "body.lock") {
        document.body.style.userSelect = "none"
        document.body.style.cursor = effect.cursor

        return
      }

      if (effect.type === "body.cursor") {
        document.body.style.cursor = effect.cursor

        return
      }

      if (effect.type === "click-suppression.arm") {
        clearSuppression?.()
        window.addEventListener("click", swallow, true)
        const timer = setTimeout(() => clearSuppression?.())
        clearSuppression = () => {
          clearTimeout(timer)
          window.removeEventListener("click", swallow, true)
          clearSuppression = undefined
        }

        return
      }

      if (effect.type === "click-suppression.clear") {
        clearSuppression?.()

        return
      }

      markDropped()

      const open =
        sidebarSessionSource?.key === effect.key
          ? { server: sidebarSessionSource.server, sessionId: sidebarSessionSource.sessionId }
          : undefined

      sidebarSessionSource = undefined

      if (effect.target.kind === "split") {
        tabs.split.splitPane(effect.key, effect.target.paneId, effect.target.side, effect.fallbackSelected, open)

        return
      }

      if (effect.target.kind === "strip") {
        tabs.split.moveTabToPane(
          effect.key,
          effect.target.paneId,
          effect.target.before,
          effect.fallbackSelected,
          open,
        )

        return
      }

      tabs.split.moveTabToPane(effect.key, effect.target.paneId, undefined, effect.fallbackSelected, open)
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return

      if (
        event.target.closest(
          '[data-slot="tab-close"], [contenteditable="true"], [contenteditable="plaintext-only"]',
        )
      ) {
        return
      }

      const tabSlot = event.target.closest<HTMLElement>("[data-titlebar-tab-slot][data-tab-key]")

      if (tabSlot) {
        const key = tabSlot.dataset.tabKey

        if (!key) return
        const title = tabSlot.querySelector<HTMLElement>("[data-titlebar-tab-title]")?.textContent?.trim() || ""
        sidebarSessionSource = undefined
        dispatch({
          type: "pointer.down",
          pointerId: event.pointerId,
          button: event.button,
          x: event.clientX,
          y: event.clientY,
          key,
          title,
          fallbackSelected: { ...tabs.split.selected() },
        })

        return
      }

      const sessionRow = event.target.closest<HTMLElement>("[data-session-drag-server][data-session-drag-id]")

      if (!sessionRow) return
      const rawServer = sessionRow.dataset.sessionDragServer
      const sessionId = sessionRow.dataset.sessionDragId

      if (!rawServer || !sessionId) return
      const server = ServerConnection.Key.make(rawServer)
      const key = tabKey({ type: "session", server, sessionId })
      const title = sessionRow.dataset.sessionDragTitle || ""
      sidebarSessionSource = { key, server, sessionId }
      dispatch({
        type: "pointer.down",
        pointerId: event.pointerId,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
        key,
        title,
        fallbackSelected: { ...tabs.split.selected() },
      })
    }

    onMount(() => {
      window.addEventListener("pointerdown", onPointerDown, true)
    })

    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown, true)

      if (clearDropFlagTimer !== undefined) clearTimeout(clearDropFlagTimer)
      dispatch({ type: "disposed" })
    })

    return {
      dragging,
      layer,
      shouldSuppressReorder: () => Boolean(layer()) || droppedRecently(),
      Layer: () => (
        <Show when={layer()}>
          {(current) => (
            <Portal>
              <div class="fixed inset-0 z-[100] pointer-events-none" data-component="session-pane-drag-layer">
                <Show when={current().target}>
                  {(target) => {
                    const splitSide = () => {
                      const item = target()

                      return item.kind === "split" ? item.side : undefined
                    }

                    return (
                      <div
                        data-slot={target().kind === "strip" ? "session-pane-drop-indicator" : "session-pane-drop-zone"}
                        data-pane={target().paneId}
                        data-drop-kind={target().kind}
                        data-split-side={splitSide()}
                        class="absolute transition-[left,top,width,height] duration-75"
                        classList={{
                          "bg-v2-icon-icon-accent rounded-full": target().kind === "strip",
                          "rounded-[10px] border border-v2-icon-icon-accent bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_12%,transparent)]":
                            target().kind !== "strip",
                        }}
                        style={{
                          left: `${target().rect.left}px`,
                          top: `${target().rect.top}px`,
                          width: `${target().rect.width}px`,
                          height: `${target().rect.height}px`,
                        }}
                      />
                    )
                  }}
                </Show>
                <div
                  class="absolute max-w-60 h-7 px-2.5 flex items-center rounded-md bg-v2-background-bg-base text-13-regular text-v2-text-text-base truncate shadow-[var(--v2-elevation-raised)] opacity-90"
                  style={{ left: `${current().x + 12}px`, top: `${current().y + 12}px` }}
                >
                  {current().title}
                </div>
              </div>
            </Portal>
          )}
        </Show>
      ),
    }
}

export type SessionPaneDragService = ReturnType<typeof createSessionPaneDragService>

const SessionPaneDragContext = createContext<SessionPaneDragService>()

export function SessionPaneDragProvider(props: ParentProps) {
  const value = createSessionPaneDragService()

  return (
    <SessionPaneDragContext.Provider value={value}>
      {props.children}
      <value.Layer />
    </SessionPaneDragContext.Provider>
  )
}

export function useSessionPaneDrag() {
  const value = useContext(SessionPaneDragContext)

  if (!value) throw new Error("SessionPaneDragContext must be used within SessionPaneDragProvider")

  return value
}

export function useSessionPaneDragOptional() {
  return useContext(SessionPaneDragContext)
}

function visibleRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const bounds = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)

    if (style.overflowX === "visible" && style.overflowY === "visible") continue
    const clip = parent.getBoundingClientRect()
    bounds.left = Math.max(bounds.left, clip.left)
    bounds.top = Math.max(bounds.top, clip.top)
    bounds.right = Math.min(bounds.right, clip.right)
    bounds.bottom = Math.min(bounds.bottom, clip.bottom)
  }

  return new DOMRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top)
}

function toRect(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}
