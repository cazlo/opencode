import { describe, expect, test } from "bun:test"
import {
  INITIAL_SESSION_PANE_DRAG_STATE,
  resolveSessionPaneBodyDrop,
  selectSessionDraggingKey,
  selectSessionDragLayer,
  selectSessionMoveKey,
  transitionSessionPaneDrag,
} from "./session-pane-drag-machine"

describe("session-pane-drag-machine", () => {
  test("resolves horizontal, vertical, and center drop targets inside a pane body", () => {
    const rect = { left: 0, top: 0, width: 1000, height: 800 }

    const left = resolveSessionPaneBodyDrop({
      x: 100,
      y: 400,
      rect,
      paneId: "main",
      sourcePaneId: "main",
      canSplit: true,
    })

    expect(left?.kind).toBe("split")

    if (left?.kind === "split") {
      expect(left.side).toBe("left")
      expect(left.rect).toEqual({ left: 0, top: 0, width: 500, height: 800 })
    }

    const right = resolveSessionPaneBodyDrop({
      x: 900,
      y: 400,
      rect,
      paneId: "main",
      sourcePaneId: "main",
      canSplit: true,
    })

    expect(right?.kind).toBe("split")

    if (right?.kind === "split") {
      expect(right.side).toBe("right")
      expect(right.rect).toEqual({ left: 500, top: 0, width: 500, height: 800 })
    }

    const top = resolveSessionPaneBodyDrop({
      x: 500,
      y: 80,
      rect,
      paneId: "main",
      sourcePaneId: "main",
      canSplit: true,
    })

    expect(top?.kind).toBe("split")

    if (top?.kind === "split") {
      expect(top.side).toBe("top")
      expect(top.rect).toEqual({ left: 0, top: 0, width: 1000, height: 400 })
    }

    const bottom = resolveSessionPaneBodyDrop({
      x: 500,
      y: 720,
      rect,
      paneId: "main",
      sourcePaneId: "main",
      canSplit: true,
    })

    expect(bottom?.kind).toBe("split")

    if (bottom?.kind === "split") {
      expect(bottom.side).toBe("bottom")
      expect(bottom.rect).toEqual({ left: 0, top: 400, width: 1000, height: 400 })
    }

    const centerWhenSplit = resolveSessionPaneBodyDrop({
      x: 500,
      y: 400,
      rect,
      paneId: "pane-2",
      sourcePaneId: "main",
      canSplit: true,
    })

    expect(centerWhenSplit).toEqual({
      kind: "move",
      paneId: "pane-2",
      rect,
    })

    const centerSamePane = resolveSessionPaneBodyDrop({
      x: 500,
      y: 400,
      rect,
      paneId: "main",
      sourcePaneId: "main",
      canSplit: true,
    })

    expect(centerSamePane).toBeUndefined()
  })

  test("transitions through pressed, dragging, drop, and escape cancellation", () => {
    const down = transitionSessionPaneDrag(INITIAL_SESSION_PANE_DRAG_STATE, {
      type: "pointer.down",
      pointerId: 1,
      button: 0,
      x: 50,
      y: 50,
      key: "tab-1",
      title: "Session 1",
      fallbackSelected: { main: "tab-0" },
    })

    expect(down.state.status).toBe("pressed")
    expect(down.effects).toEqual([{ type: "gesture.attach" }])

    // Below threshold does not start dragging
    expect(selectSessionMoveKey(down.state, 1, 52, 52)).toBeUndefined()
    // Past threshold activates drag
    expect(selectSessionMoveKey(down.state, 1, 70, 50)).toBe("tab-1")

    const target = {
      kind: "split" as const,
      paneId: "main",
      side: "right" as const,
      rect: { left: 500, top: 0, width: 500, height: 800 },
    }

    const moved = transitionSessionPaneDrag(down.state, {
      type: "pointer.move",
      pointerId: 1,
      x: 70,
      y: 50,
      target,
    })

    expect(selectSessionDraggingKey(moved.state)).toBe("tab-1")
    expect(selectSessionDragLayer(moved.state)?.target).toEqual(target)

    const dropped = transitionSessionPaneDrag(moved.state, {
      type: "pointer.up",
      pointerId: 1,
    })

    expect(dropped.state).toEqual(INITIAL_SESSION_PANE_DRAG_STATE)
    expect(dropped.effects).toContainEqual({
      type: "drop",
      key: "tab-1",
      target,
      fallbackSelected: { main: "tab-0" },
    })

    const escaped = transitionSessionPaneDrag(moved.state, { type: "escape" })
    expect(escaped.state).toEqual(INITIAL_SESSION_PANE_DRAG_STATE)
  })
})
