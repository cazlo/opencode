import type { TabStorage } from "./schema"

export type SessionSplitDirection = "horizontal" | "vertical"

export type SessionSplitSide = "left" | "right" | "top" | "bottom"

export type SessionSplitBranch = typeof TabStorage.SplitBranch.Type

export type SessionSplitState = typeof TabStorage.Splits.Type

export type SessionSplitNode =
  | {
      type: "pane"
      id: string
    }
  | {
      type: "split"
      id: string
      direction: SessionSplitDirection
      ratio: number
      first: SessionSplitNode
      second: SessionSplitNode
    }

export type SessionSplitBox = {
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
}

export type SessionSplitDivider = {
  readonly id: string
  readonly direction: SessionSplitDirection
  readonly ratio: number
  readonly box: SessionSplitBox
}

const FULL_SPLIT_BOX: SessionSplitBox = { x0: 0, x1: 1, y0: 0, y1: 1 }

export function computeSessionSplitLayout(root: SessionSplitNode) {
  const panes = new Map<string, SessionSplitBox>()
  const dividers: SessionSplitDivider[] = []

  const visit = (node: SessionSplitNode, box: SessionSplitBox) => {
    if (node.type === "pane") {
      panes.set(node.id, box)

      return
    }

    dividers.push({
      id: node.id,
      direction: node.direction,
      ratio: node.ratio,
      box,
    })

    if (node.direction === "horizontal") {
      const mid = box.x0 + (box.x1 - box.x0) * node.ratio
      visit(node.first, { x0: box.x0, x1: mid, y0: box.y0, y1: box.y1 })
      visit(node.second, { x0: mid, x1: box.x1, y0: box.y0, y1: box.y1 })

      return
    }

    const mid = box.y0 + (box.y1 - box.y0) * node.ratio
    visit(node.first, { x0: box.x0, x1: box.x1, y0: box.y0, y1: mid })
    visit(node.second, { x0: box.x0, x1: box.x1, y0: mid, y1: box.y1 })
  }

  visit(root, FULL_SPLIT_BOX)

  return { panes, dividers }
}

const DEFAULT_PANE_ID = "main"

const MIN_SPLIT_RATIO = 0.1

const MAX_SPLIT_RATIO = 0.9

export const INITIAL_SESSION_SPLIT_STATE: SessionSplitState = {
  root: DEFAULT_PANE_ID,
  splits: [],
  activePane: DEFAULT_PANE_ID,
  panes: {},
  selected: {},
}

export function clampSessionSplitRatio(ratio: number) {
  if (!Number.isFinite(ratio)) return 0.5

  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

export function buildSessionSplitTree(state: Pick<SessionSplitState, "root" | "splits">): SessionSplitNode {
  const byId = new Map(state.splits.map((branch) => [branch.id, branch]))
  const visited = new Set<string>()

  const visit = (id: string): SessionSplitNode => {
    const branch = byId.get(id)

    if (!branch || visited.has(id) || branch.first === branch.second) {
      return { type: "pane", id }
    }

    visited.add(id)

    return {
      type: "split",
      id: branch.id,
      direction: branch.direction,
      ratio: clampSessionSplitRatio(branch.ratio),
      first: visit(branch.first),
      second: visit(branch.second),
    }
  }

  return visit(state.root || DEFAULT_PANE_ID)
}

export function listSessionSplitPanes(node: SessionSplitNode): string[] {
  if (node.type === "pane") return [node.id]

  return [...listSessionSplitPanes(node.first), ...listSessionSplitPanes(node.second)]
}

export function flattenSessionSplitTree(node: SessionSplitNode) {
  const splits: SessionSplitBranch[] = []
  const seenPanes = new Set<string>()

  const visit = (current: SessionSplitNode): string => {
    if (current.type === "pane") {
      seenPanes.add(current.id)

      return current.id
    }

    const first = visit(current.first)
    const second = visit(current.second)

    if (first === second) return first
    splits.push({
      id: current.id,
      direction: current.direction,
      ratio: clampSessionSplitRatio(current.ratio),
      first,
      second,
    })

    return current.id
  }

  const root = visit(node)

  return { root, splits }
}

function pruneSessionSplitNode(node: SessionSplitNode, keepPanes: ReadonlySet<string>): SessionSplitNode | undefined {
  if (node.type === "pane") {
    return keepPanes.has(node.id) ? node : undefined
  }

  const first = pruneSessionSplitNode(node.first, keepPanes)
  const second = pruneSessionSplitNode(node.second, keepPanes)

  if (first && second) {
    if (first === node.first && second === node.second) return node

    return { ...node, first, second }
  }

  return first ?? second
}

function replacePaneInTree(
  node: SessionSplitNode,
  targetPaneId: string,
  replacement: SessionSplitNode,
): SessionSplitNode {
  if (node.type === "pane") {
    return node.id === targetPaneId ? replacement : node
  }

  const first = replacePaneInTree(node.first, targetPaneId, replacement)
  const second = replacePaneInTree(node.second, targetPaneId, replacement)

  if (first === node.first && second === node.second) return node

  return { ...node, first, second }
}

export function sessionSplitStateEqual(a: SessionSplitState, b: SessionSplitState): boolean {
  if (a === b) return true

  if (a.root !== b.root || a.activePane !== b.activePane) return false

  if (a.splits.length !== b.splits.length) return false

  for (let i = 0; i < a.splits.length; i++) {
    const left = a.splits[i]
    const right = b.splits[i]

    if (!left || !right) return false

    if (
      left.id !== right.id ||
      left.direction !== right.direction ||
      left.ratio !== right.ratio ||
      left.first !== right.first ||
      left.second !== right.second
    ) {
      return false
    }
  }

  const aPaneKeys = Object.keys(a.panes)
  const bPaneKeys = Object.keys(b.panes)

  if (aPaneKeys.length !== bPaneKeys.length) return false

  for (const key of aPaneKeys) {
    if (a.panes[key] !== b.panes[key]) return false
  }

  const aSelectedKeys = Object.keys(a.selected)
  const bSelectedKeys = Object.keys(b.selected)

  if (aSelectedKeys.length !== bSelectedKeys.length) return false

  for (const key of aSelectedKeys) {
    if (a.selected[key] !== b.selected[key]) return false
  }

  return true
}

export function reconcileSessionSplits(
  state: SessionSplitState,
  tabKeys: readonly string[],
  routedTabKey?: string,
  options?: { preserveActivePane?: boolean },
): SessionSplitState {
  if (tabKeys.length === 0) {
    return sessionSplitStateEqual(state, INITIAL_SESSION_SPLIT_STATE) ? state : INITIAL_SESSION_SPLIT_STATE
  }

  const initialTree = buildSessionSplitTree(state)
  const initialPanes = listSessionSplitPanes(initialTree)
  const initialPaneSet = new Set(initialPanes)

  const defaultPane = initialPaneSet.has(state.activePane)
    ? state.activePane
    : (initialPanes[0] ?? DEFAULT_PANE_ID)

  const preliminaryPanes: Record<string, string> = {}
  const preliminaryCounts = new Set<string>()

  for (const key of tabKeys) {
    const assigned = state.panes[key]
    const paneId = assigned && initialPaneSet.has(assigned) ? assigned : defaultPane
    preliminaryPanes[key] = paneId
    preliminaryCounts.add(paneId)
  }

  const prunedTree =
    pruneSessionSplitNode(initialTree, preliminaryCounts) ?? {
      type: "pane",
      id: preliminaryPanes[tabKeys[0]!] ?? DEFAULT_PANE_ID,
    }

  const flattened = flattenSessionSplitTree(prunedTree)
  const validTree = buildSessionSplitTree(flattened)
  const validPanes = listSessionSplitPanes(validTree)
  const validPaneSet = new Set(validPanes)
  const fallbackPane = validPanes[0] ?? DEFAULT_PANE_ID

  const panes: Record<string, string> = {}
  const tabsByPane = new Map<string, string[]>()

  for (const paneId of validPanes) {
    tabsByPane.set(paneId, [])
  }

  for (const key of tabKeys) {
    const candidate = preliminaryPanes[key]
    const paneId = candidate && validPaneSet.has(candidate) ? candidate : fallbackPane
    panes[key] = paneId
    const list = tabsByPane.get(paneId)

    if (list) list.push(key)
  }

  const routedPane = routedTabKey ? panes[routedTabKey] : undefined

  const activePane =
    !options?.preserveActivePane && routedPane && validPaneSet.has(routedPane)
      ? routedPane
      : validPaneSet.has(state.activePane)
        ? state.activePane
        : (routedPane && validPaneSet.has(routedPane) ? routedPane : fallbackPane)

  const selected: Record<string, string> = {}

  for (const paneId of validPanes) {
    const paneTabs = tabsByPane.get(paneId) ?? []
    const currentSelected = state.selected[paneId]

    const nextSelected =
      routedTabKey && routedPane === paneId && paneTabs.includes(routedTabKey)
        ? routedTabKey
        : currentSelected && paneTabs.includes(currentSelected)
          ? currentSelected
          : paneTabs[0]

    if (nextSelected) selected[paneId] = nextSelected
  }

  const next: SessionSplitState = {
    root: flattened.root,
    splits: flattened.splits,
    activePane,
    panes,
    selected,
  }

  return sessionSplitStateEqual(state, next) ? state : next
}

export function canSplitSessionPaneWithTab(
  state: SessionSplitState,
  tabKey: string,
  targetPaneId: string,
  tabKeys: readonly string[],
): boolean {
  const reconciled = reconcileSessionSplits(state, tabKeys)
  const targetTabs = tabKeys.filter((key) => reconciled.panes[key] === targetPaneId)

  if (targetTabs.length === 0) return false
  const sourcePaneId = reconciled.panes[tabKey]

  if (!sourcePaneId) return true
  const sourceTabs = tabKeys.filter((key) => reconciled.panes[key] === sourcePaneId)

  if (sourcePaneId === targetPaneId) return targetTabs.length > 1

  return sourceTabs.length > 0
}

export function splitSessionPane(
  state: SessionSplitState,
  input: {
    tabKey: string
    targetPaneId: string
    side: SessionSplitSide
    newPaneId: string
    splitId: string
    tabKeys: readonly string[]
    fallbackSelected?: Readonly<Record<string, string>>
  },
): SessionSplitState {
  const nextTabKeys = input.tabKeys.includes(input.tabKey) ? input.tabKeys : [...input.tabKeys, input.tabKey]
  const base = reconcileSessionSplits(state, nextTabKeys, undefined, { preserveActivePane: true })
  const tree = buildSessionSplitTree(base)
  const panes = listSessionSplitPanes(tree)

  if (!panes.includes(input.targetPaneId)) return base

  const targetTabs = nextTabKeys.filter((key) => base.panes[key] === input.targetPaneId && key !== input.tabKey)

  if (targetTabs.length === 0) return base

  const direction: SessionSplitDirection =
    input.side === "left" || input.side === "right" ? "horizontal" : "vertical"

  const targetNode: SessionSplitNode = { type: "pane", id: input.targetPaneId }
  const newNode: SessionSplitNode = { type: "pane", id: input.newPaneId }

  const replacement: SessionSplitNode =
    input.side === "left" || input.side === "top"
      ? { type: "split", id: input.splitId, direction, ratio: 0.5, first: newNode, second: targetNode }
      : { type: "split", id: input.splitId, direction, ratio: 0.5, first: targetNode, second: newNode }

  const nextTree = replacePaneInTree(tree, input.targetPaneId, replacement)
  const flattened = flattenSessionSplitTree(nextTree)

  const nextPanes = {
    ...base.panes,
    [input.tabKey]: input.newPaneId,
  }

  const mergedSelected: SessionSplitState["selected"] = {
    ...base.selected,
    ...input.fallbackSelected,
    [input.newPaneId]: input.tabKey,
  }

  for (const paneId of Object.keys(mergedSelected)) {
    const selectedKey = mergedSelected[paneId]

    if (paneId !== input.newPaneId && selectedKey === input.tabKey) {
      const fallback = input.fallbackSelected?.[paneId]

      if (fallback && fallback !== input.tabKey) {
        mergedSelected[paneId] = fallback
      }

      if (!fallback || fallback === input.tabKey) {
        delete mergedSelected[paneId]
      }
    }
  }

  return reconcileSessionSplits(
    {
      root: flattened.root,
      splits: flattened.splits,
      activePane: input.newPaneId,
      panes: nextPanes,
      selected: mergedSelected,
    },
    nextTabKeys,
    input.tabKey,
  )
}

export function moveTabToSessionPane(
  state: SessionSplitState,
  input: {
    tabKey: string
    targetPaneId: string
    beforeTabKey?: string
    tabKeys: readonly string[]
    fallbackSelected?: Readonly<Record<string, string>>
  },
) {
  const nextTabKeys = input.tabKeys.includes(input.tabKey) ? [...input.tabKeys] : [...input.tabKeys, input.tabKey]
  const base = reconcileSessionSplits(state, nextTabKeys, undefined, { preserveActivePane: true })
  const tree = buildSessionSplitTree(base)
  const validPanes = listSessionSplitPanes(tree)

  if (!validPanes.includes(input.targetPaneId)) {
    return { state: base, orderedTabKeys: nextTabKeys }
  }

  const withoutMoved = nextTabKeys.filter((key) => key !== input.tabKey)

  const orderedTabKeys = (() => {
    if (input.beforeTabKey && input.beforeTabKey !== input.tabKey) {
      const beforeIndex = withoutMoved.indexOf(input.beforeTabKey)

      if (beforeIndex !== -1) {
        const copy = [...withoutMoved]
        copy.splice(beforeIndex, 0, input.tabKey)

        return copy
      }
    }

    const lastInTargetIndex = withoutMoved.findLastIndex((key) => base.panes[key] === input.targetPaneId)

    if (lastInTargetIndex !== -1) {
      const copy = [...withoutMoved]
      copy.splice(lastInTargetIndex + 1, 0, input.tabKey)

      return copy
    }

    return [...withoutMoved, input.tabKey]
  })()

  const nextPanes = {
    ...base.panes,
    [input.tabKey]: input.targetPaneId,
  }

  const mergedSelected: SessionSplitState["selected"] = {
    ...base.selected,
    ...input.fallbackSelected,
  }

  for (const paneId of Object.keys(mergedSelected)) {
    const selectedKey = mergedSelected[paneId]

    if (paneId !== input.targetPaneId && selectedKey === input.tabKey) {
      const fallback = input.fallbackSelected?.[paneId]

      if (fallback && fallback !== input.tabKey) {
        mergedSelected[paneId] = fallback
      }

      if (!fallback || fallback === input.tabKey) {
        delete mergedSelected[paneId]
      }
    }
  }

  mergedSelected[input.targetPaneId] = input.tabKey

  const nextState = reconcileSessionSplits(
    {
      root: base.root,
      splits: base.splits,
      activePane: input.targetPaneId,
      panes: nextPanes,
      selected: mergedSelected,
    },
    orderedTabKeys,
    input.tabKey,
  )

  return { state: nextState, orderedTabKeys }
}

export function resizeSessionSplit(state: SessionSplitState, splitId: string, ratio: number): SessionSplitState {
  const clamped = clampSessionSplitRatio(ratio)
  const index = state.splits.findIndex((branch) => branch.id === splitId)

  if (index === -1) return state
  const current = state.splits[index]

  if (!current || current.ratio === clamped) return state
  const splits = state.splits.map((branch, i) => (i === index ? { ...branch, ratio: clamped } : branch))

  return {
    ...state,
    splits,
  }
}

export function replaceSessionSplitTabKey(
  state: SessionSplitState,
  fromKey: string,
  toKey: string,
): SessionSplitState {
  if (fromKey === toKey) return state
  const paneId = state.panes[fromKey]

  if (!paneId) return state
  const panes = { ...state.panes }
  delete panes[fromKey]
  panes[toKey] = paneId
  const selected = { ...state.selected }

  for (const id of Object.keys(selected)) {
    if (selected[id] === fromKey) selected[id] = toKey
  }

  return {
    ...state,
    panes,
    selected,
  }
}

export function mergeSessionPane(
  state: SessionSplitState,
  paneId: string,
  tabKeys: readonly string[],
  routedTabKey?: string,
): SessionSplitState {
  const base = reconcileSessionSplits(state, tabKeys, routedTabKey)
  const panes = listSessionSplitPanes(buildSessionSplitTree(base))

  if (panes.length <= 1 || !panes.includes(paneId)) return base
  const index = panes.indexOf(paneId)
  const targetPaneId = panes[index + 1] ?? panes[index - 1]

  if (!targetPaneId) return base
  const nextPanes = { ...base.panes }

  for (const key of Object.keys(nextPanes)) {
    if (nextPanes[key] === paneId) nextPanes[key] = targetPaneId
  }

  const nextSelected = { ...base.selected }

  if (!nextSelected[targetPaneId] && nextSelected[paneId]) {
    nextSelected[targetPaneId] = nextSelected[paneId]!
  }

  delete nextSelected[paneId]

  return reconcileSessionSplits(
    {
      ...base,
      activePane: base.activePane === paneId ? targetPaneId : base.activePane,
      panes: nextPanes,
      selected: nextSelected,
    },
    tabKeys,
    routedTabKey,
  )
}
