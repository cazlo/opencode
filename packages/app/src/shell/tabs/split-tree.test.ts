import { describe, expect, test } from "bun:test"
import {
  INITIAL_SESSION_SPLIT_STATE,
  buildSessionSplitTree,
  canSplitSessionPaneWithTab,
  computeSessionSplitLayout,
  listSessionSplitPanes,
  mergeSessionPane,
  moveTabToSessionPane,
  reconcileSessionSplits,
  replaceSessionSplitTabKey,
  resizeSessionSplit,
  splitSessionPane,
} from "./split-tree"

describe("split-tree", () => {
  test("assigns open tabs to the main pane and tracks routed selection", () => {
    const state = reconcileSessionSplits(INITIAL_SESSION_SPLIT_STATE, ["tab-a", "tab-b"], "tab-b")
    expect(listSessionSplitPanes(buildSessionSplitTree(state))).toEqual(["main"])
    expect(state.activePane).toBe("main")
    expect(state.panes).toEqual({
      "tab-a": "main",
      "tab-b": "main",
    })
    expect(state.selected).toEqual({
      main: "tab-b",
    })
  })

  test("splits horizontally and vertically into a 2x2 grid and computes pane layout boxes", () => {
    const tabs = ["tab-1", "tab-2", "tab-3", "tab-4"]
    const initial = reconcileSessionSplits(INITIAL_SESSION_SPLIT_STATE, tabs, "tab-1")

    expect(canSplitSessionPaneWithTab(initial, "tab-1", "main", tabs)).toBe(true)
    expect(canSplitSessionPaneWithTab(initial, "tab-1", "main", ["tab-1"])).toBe(false)

    // Split right: main (left) | pane-right (right)
    const afterHorizontal = splitSessionPane(initial, {
      tabKey: "tab-2",
      targetPaneId: "main",
      side: "right",
      newPaneId: "pane-right",
      splitId: "split-h",
      tabKeys: tabs,
      fallbackSelected: { main: "tab-1" },
    })

    expect(listSessionSplitPanes(buildSessionSplitTree(afterHorizontal))).toEqual(["main", "pane-right"])
    expect(afterHorizontal.activePane).toBe("pane-right")
    expect(afterHorizontal.selected).toEqual({
      main: "tab-1",
      "pane-right": "tab-2",
    })

    // Split main bottom: main (top-left) / pane-bottom-left (bottom-left)
    const afterLeftVertical = splitSessionPane(afterHorizontal, {
      tabKey: "tab-3",
      targetPaneId: "main",
      side: "bottom",
      newPaneId: "pane-bottom-left",
      splitId: "split-v-left",
      tabKeys: tabs,
      fallbackSelected: { main: "tab-1", "pane-right": "tab-2" },
    })

    // Split pane-right bottom using an external sidebar tab (tab-5)
    const afterGrid = splitSessionPane(afterLeftVertical, {
      tabKey: "tab-5",
      targetPaneId: "pane-right",
      side: "bottom",
      newPaneId: "pane-bottom-right",
      splitId: "split-v-right",
      tabKeys: tabs,
      fallbackSelected: afterLeftVertical.selected,
    })

    const tree = buildSessionSplitTree(afterGrid)
    expect(listSessionSplitPanes(tree)).toEqual([
      "main",
      "pane-bottom-left",
      "pane-right",
      "pane-bottom-right",
    ])

    const layout = computeSessionSplitLayout(tree)
    expect(layout.dividers.map((item) => item.id)).toEqual(["split-h", "split-v-left", "split-v-right"])
    expect(layout.panes.get("main")).toEqual({ x0: 0, x1: 0.5, y0: 0, y1: 0.5 })
    expect(layout.panes.get("pane-bottom-left")).toEqual({ x0: 0, x1: 0.5, y0: 0.5, y1: 1 })
    expect(layout.panes.get("pane-right")).toEqual({ x0: 0.5, x1: 1, y0: 0, y1: 0.5 })
    expect(layout.panes.get("pane-bottom-right")).toEqual({ x0: 0.5, x1: 1, y0: 0.5, y1: 1 })
  })

  test("moves tabs between panes and collapses an emptied pane", () => {
    const tabs = ["tab-a", "tab-b", "tab-c"]
    const initial = reconcileSessionSplits(INITIAL_SESSION_SPLIT_STATE, tabs, "tab-a")

    const split = splitSessionPane(initial, {
      tabKey: "tab-c",
      targetPaneId: "main",
      side: "right",
      newPaneId: "pane-2",
      splitId: "split-1",
      tabKeys: tabs,
      fallbackSelected: { main: "tab-a" },
    })

    // Move tab-b into pane-2 before tab-c
    const movedIntoSecond = moveTabToSessionPane(split, {
      tabKey: "tab-b",
      targetPaneId: "pane-2",
      beforeTabKey: "tab-c",
      tabKeys: tabs,
      fallbackSelected: { main: "tab-a", "pane-2": "tab-c" },
    })

    expect(movedIntoSecond.orderedTabKeys).toEqual(["tab-a", "tab-b", "tab-c"])
    expect(movedIntoSecond.state.panes["tab-b"]).toBe("pane-2")
    expect(movedIntoSecond.state.selected["main"]).toBe("tab-a")
    expect(movedIntoSecond.state.selected["pane-2"]).toBe("tab-b")

    // Move tab-a (the last tab in main) into pane-2 -> main collapses
    const collapsed = moveTabToSessionPane(movedIntoSecond.state, {
      tabKey: "tab-a",
      targetPaneId: "pane-2",
      tabKeys: movedIntoSecond.orderedTabKeys,
    })

    expect(listSessionSplitPanes(buildSessionSplitTree(collapsed.state))).toEqual(["pane-2"])
    expect(collapsed.state.splits).toEqual([])
  })

  test("resizes splits with ratio clamping, replaces promoted tab keys, and merges panes", () => {
    const tabs = ["draft:1", "tab-2"]
    const initial = reconcileSessionSplits(INITIAL_SESSION_SPLIT_STATE, tabs, "draft:1")

    const split = splitSessionPane(initial, {
      tabKey: "tab-2",
      targetPaneId: "main",
      side: "right",
      newPaneId: "pane-2",
      splitId: "split-1",
      tabKeys: tabs,
      fallbackSelected: { main: "draft:1" },
    })

    const resized = resizeSessionSplit(split, "split-1", 0.95)
    expect(resized.splits[0]?.ratio).toBe(0.9)

    const promoted = replaceSessionSplitTabKey(resized, "draft:1", "session:1")
    expect(promoted.panes["session:1"]).toBe("main")
    expect(promoted.selected["main"]).toBe("session:1")

    const merged = mergeSessionPane(promoted, "pane-2", ["session:1", "tab-2"])
    expect(listSessionSplitPanes(buildSessionSplitTree(merged))).toEqual(["main"])
    expect(merged.splits).toEqual([])
  })
})
