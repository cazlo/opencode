import type { SessionSplitSide } from "./split-tree"

export const DRAG_THRESHOLD_PX = 4

export const SPLIT_EDGE_RATIO = 0.28

export type Rect = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type SessionPaneDropTarget =
  | {
      readonly kind: "strip"
      readonly paneId: string
      readonly before?: string
      readonly rect: Rect
    }
  | {
      readonly kind: "split"
      readonly paneId: string
      readonly side: SessionSplitSide
      readonly rect: Rect
    }
  | {
      readonly kind: "move"
      readonly paneId: string
      readonly rect: Rect
    }

export type SessionPaneDragState =
  | { readonly status: "idle" }
  | {
      readonly status: "pressed"
      readonly pointerId: number
      readonly key: string
      readonly title: string
      readonly originX: number
      readonly originY: number
      readonly fallbackSelected: Readonly<Record<string, string>>
    }
  | {
      readonly status: "dragging"
      readonly pointerId: number
      readonly key: string
      readonly title: string
      readonly x: number
      readonly y: number
      readonly fallbackSelected: Readonly<Record<string, string>>
      readonly target: SessionPaneDropTarget | undefined
    }
  | { readonly status: "disposed" }

export type DraggingSessionPaneState = Extract<SessionPaneDragState, { readonly status: "dragging" }>

export type SessionPaneDragEvent =
  | {
      readonly type: "pointer.down"
      readonly pointerId: number
      readonly button: number
      readonly x: number
      readonly y: number
      readonly key: string
      readonly title: string
      readonly fallbackSelected: Readonly<Record<string, string>>
    }
  | {
      readonly type: "pointer.move"
      readonly pointerId: number
      readonly x: number
      readonly y: number
      readonly target: SessionPaneDropTarget | undefined
    }
  | { readonly type: "pointer.up"; readonly pointerId: number }
  | { readonly type: "pointer.cancel"; readonly pointerId: number }
  | { readonly type: "escape" }
  | { readonly type: "blur" }
  | { readonly type: "disposed" }

export type SessionPaneDragCursor = "grabbing" | ""

export type SessionPaneDragEffect =
  | { readonly type: "gesture.attach" }
  | { readonly type: "gesture.cleanup"; readonly unlockBody: boolean }
  | { readonly type: "body.lock"; readonly cursor: SessionPaneDragCursor }
  | { readonly type: "body.cursor"; readonly cursor: SessionPaneDragCursor }
  | { readonly type: "click-suppression.arm" }
  | { readonly type: "click-suppression.clear" }
  | {
      readonly type: "drop"
      readonly key: string
      readonly target: SessionPaneDropTarget
      readonly fallbackSelected: Readonly<Record<string, string>>
    }

export type SessionPaneDragTransition = {
  readonly state: SessionPaneDragState
  readonly effects: readonly SessionPaneDragEffect[]
}

export const INITIAL_SESSION_PANE_DRAG_STATE: SessionPaneDragState = Object.freeze({ status: "idle" })

export const DISPOSED_SESSION_PANE_DRAG_STATE: SessionPaneDragState = Object.freeze({ status: "disposed" })

const EMPTY_EFFECTS: readonly SessionPaneDragEffect[] = Object.freeze([])

const ATTACH: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "gesture.attach" }])

const CLEANUP_PRESSED: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "gesture.cleanup", unlockBody: false }])

const CLEANUP_DRAGGING: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "gesture.cleanup", unlockBody: true }])

const RELEASE: readonly SessionPaneDragEffect[] = Object.freeze([
  ...CLEANUP_DRAGGING,
  { type: "click-suppression.arm" },
])

const LOCK_GRABBING: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "body.lock", cursor: "grabbing" }])

const LOCK_DEFAULT: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "body.lock", cursor: "" }])

const CURSOR_GRABBING: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "body.cursor", cursor: "grabbing" }])

const CURSOR_DEFAULT: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "body.cursor", cursor: "" }])

const DISPOSE_IDLE: readonly SessionPaneDragEffect[] = Object.freeze([{ type: "click-suppression.clear" }])

const DISPOSE_PRESSED: readonly SessionPaneDragEffect[] = Object.freeze([...CLEANUP_PRESSED, ...DISPOSE_IDLE])

const DISPOSE_DRAGGING: readonly SessionPaneDragEffect[] = Object.freeze([...CLEANUP_DRAGGING, ...DISPOSE_IDLE])

export function transitionSessionPaneDrag(
  state: SessionPaneDragState,
  event: SessionPaneDragEvent,
): SessionPaneDragTransition {
  if (state.status === "disposed") return unchanged(state)

  if (event.type === "disposed") return disposed(state)

  if (state.status === "idle") return idle(state, event)

  if (state.status === "pressed") return pressed(state, event)

  return dragging(state, event)
}

export function selectSessionDraggingKey(state: SessionPaneDragState) {
  return state.status === "dragging" ? state.key : undefined
}

export function selectSessionDragLayer(state: SessionPaneDragState) {
  return state.status === "dragging" && state.target ? state : undefined
}

export function selectSessionMoveKey(state: SessionPaneDragState, pointerId: number, x: number, y: number) {
  if (state.status === "dragging") return state.pointerId === pointerId ? state.key : undefined

  if (state.status !== "pressed" || state.pointerId !== pointerId) return undefined

  return Math.hypot(x - state.originX, y - state.originY) >= DRAG_THRESHOLD_PX ? state.key : undefined
}

export function resolveSessionPaneBodyDrop(input: {
  readonly x: number
  readonly y: number
  readonly rect: Rect
  readonly paneId: string
  readonly sourcePaneId: string | undefined
  readonly canSplit: boolean
}): SessionPaneDropTarget | undefined {
  const rect = input.rect

  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    input.x < rect.left ||
    input.x > rect.left + rect.width ||
    input.y < rect.top ||
    input.y > rect.top + rect.height
  ) {
    return undefined
  }

  const relX = (input.x - rect.left) / rect.width
  const relY = (input.y - rect.top) / rect.height
  const distLeft = relX
  const distRight = 1 - relX
  const distTop = relY
  const distBottom = 1 - relY
  const minDist = Math.min(distLeft, distRight, distTop, distBottom)

  if (minDist <= SPLIT_EDGE_RATIO && input.canSplit) {
    const side: SessionSplitSide =
      minDist === distLeft
        ? "left"
        : minDist === distRight
          ? "right"
          : minDist === distTop
            ? "top"
            : "bottom"

    return {
      kind: "split",
      paneId: input.paneId,
      side,
      rect: splitSideRect(rect, side),
    }
  }

  if (input.sourcePaneId && input.sourcePaneId !== input.paneId) {
    return {
      kind: "move",
      paneId: input.paneId,
      rect,
    }
  }

  return undefined
}

function splitSideRect(rect: Rect, side: SessionSplitSide): Rect {
  if (side === "left") return { left: rect.left, top: rect.top, width: rect.width / 2, height: rect.height }

  if (side === "right")
    return { left: rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height }

  if (side === "top") return { left: rect.left, top: rect.top, width: rect.width, height: rect.height / 2 }

  return { left: rect.left, top: rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 }
}

function idle(
  state: Extract<SessionPaneDragState, { status: "idle" }>,
  event: SessionPaneDragEvent,
): SessionPaneDragTransition {
  if (event.type !== "pointer.down" || event.button !== 0) return unchanged(state)

  return {
    state: {
      status: "pressed",
      pointerId: event.pointerId,
      key: event.key,
      title: event.title,
      originX: event.x,
      originY: event.y,
      fallbackSelected: event.fallbackSelected,
    },
    effects: ATTACH,
  }
}

function pressed(
  state: Extract<SessionPaneDragState, { status: "pressed" }>,
  event: SessionPaneDragEvent,
): SessionPaneDragTransition {
  if (event.type === "pointer.move") {
    if (selectSessionMoveKey(state, event.pointerId, event.x, event.y) === undefined) return unchanged(state)

    return {
      state: {
        status: "dragging",
        pointerId: state.pointerId,
        key: state.key,
        title: state.title,
        x: event.x,
        y: event.y,
        fallbackSelected: state.fallbackSelected,
        target: event.target,
      },
      effects: event.target ? LOCK_GRABBING : LOCK_DEFAULT,
    }
  }

  if (event.type === "pointer.up" || event.type === "pointer.cancel") {
    if (event.pointerId !== state.pointerId) return unchanged(state)

    return { state: INITIAL_SESSION_PANE_DRAG_STATE, effects: CLEANUP_PRESSED }
  }

  if (event.type === "escape" || event.type === "blur") {
    return { state: INITIAL_SESSION_PANE_DRAG_STATE, effects: CLEANUP_PRESSED }
  }

  return unchanged(state)
}

function dragging(state: DraggingSessionPaneState, event: SessionPaneDragEvent): SessionPaneDragTransition {
  if (event.type === "pointer.move") {
    if (event.pointerId !== state.pointerId) return unchanged(state)
    const same = sameTarget(state.target, event.target)

    if (same && event.x === state.x && event.y === state.y) return unchanged(state)

    return {
      state: {
        ...state,
        x: event.x,
        y: event.y,
        target: same ? state.target : event.target,
      },
      effects: cursor(state.target, event.target),
    }
  }

  if (event.type === "pointer.up") {
    if (event.pointerId !== state.pointerId) return unchanged(state)

    return {
      state: INITIAL_SESSION_PANE_DRAG_STATE,
      effects: state.target
        ? [
            ...RELEASE,
            {
              type: "drop",
              key: state.key,
              target: state.target,
              fallbackSelected: state.fallbackSelected,
            },
          ]
        : CLEANUP_DRAGGING,
    }
  }

  if (event.type === "pointer.cancel") {
    if (event.pointerId !== state.pointerId) return unchanged(state)

    return { state: INITIAL_SESSION_PANE_DRAG_STATE, effects: CLEANUP_DRAGGING }
  }

  if (event.type === "escape" || event.type === "blur") {
    return { state: INITIAL_SESSION_PANE_DRAG_STATE, effects: CLEANUP_DRAGGING }
  }

  return unchanged(state)
}

function disposed(state: SessionPaneDragState): SessionPaneDragTransition {
  if (state.status === "pressed") return { state: DISPOSED_SESSION_PANE_DRAG_STATE, effects: DISPOSE_PRESSED }

  if (state.status === "dragging") return { state: DISPOSED_SESSION_PANE_DRAG_STATE, effects: DISPOSE_DRAGGING }

  return { state: DISPOSED_SESSION_PANE_DRAG_STATE, effects: DISPOSE_IDLE }
}

function cursor(previous: SessionPaneDropTarget | undefined, next: SessionPaneDropTarget | undefined) {
  if (Boolean(previous) === Boolean(next)) return EMPTY_EFFECTS

  return next ? CURSOR_GRABBING : CURSOR_DEFAULT
}

function sameTarget(a: SessionPaneDropTarget | undefined, b: SessionPaneDropTarget | undefined) {
  if (a === b) return true

  if (!a || !b) return false

  if (a.kind !== b.kind || a.paneId !== b.paneId) return false

  if (a.kind === "strip" && b.kind === "strip" && a.before !== b.before) return false

  if (a.kind === "split" && b.kind === "split" && a.side !== b.side) return false

  return (
    a.rect.left === b.rect.left &&
    a.rect.top === b.rect.top &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  )
}

function unchanged(state: SessionPaneDragState): SessionPaneDragTransition {
  return { state, effects: EMPTY_EFFECTS }
}
