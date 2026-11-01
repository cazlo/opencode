import { expect, test } from "bun:test"
import { clampSessionPanelWidth, subagentPaneLayout } from "./session-panel-width"

test.each([
  ["keeps widths already within the limit", 800, 1700, false, false, 800],
  ["reserves the unified review pane minimum", 1600, 1700, false, false, 1220],
  ["reserves a larger minimum for split diffs", 1600, 1700, true, false, 900],
  // Regression: the old cap was 45% of the window, forcing the review pane to at least 55%.
  ["lets the chat panel take everything beyond the review pane minimum", 3440, 3440, false, false, 2960],
  ["holds the chat panel minimum when there is no room for both", 1600, 700, true, false, 450],
  ["never drops below the chat panel minimum on small windows", 1600, 0, false, false, 450],
  ["skips clamping before the layout is measured", 1600, undefined, false, false, 1600],
  ["lets a dragged width leave the side pane its hard minimum, split diffs included", 1600, 1700, true, true, 1380],
  ["keeps a dragged width below the default minimum", 420, 900, true, true, 420],
  ["never drops a dragged width below the hard chat minimum", 1600, 0, false, true, 400],
  ["raises a width dragged below the hard chat minimum before it rose", 320, 1700, false, true, 400],
])("%s", (_name, width, available, split, resized, expected) => {
  expect(clampSessionPanelWidth({ width, available, split, resized })).toBe(expected)
})

test.each([
  ["keeps the stored width until the chat column is measured", 500, undefined, { docked: true, width: 500, max: 500 }],
  ["raises a stored width below the minimum", 200, undefined, { docked: true, width: 280, max: 280 }],
  [
    "docks at the stored width while the transcript keeps its minimum",
    420,
    1000,
    { docked: true, width: 420, max: 680 },
  ],
  ["clamps the width to the room beside the transcript minimum", 700, 800, { docked: true, width: 480, max: 480 }],
  [
    "docks at the minimum width of the chat column a session opens with beside review",
    420,
    600,
    { docked: true, width: 280, max: 280 },
  ],
  ["floats when the transcript would fall below its minimum", 420, 599, { docked: false, width: 420, max: 551 }],
  ["floats narrower than the chat so its end stays visible", 700, 599, { docked: false, width: 551, max: 551 }],
  ["never floats below the pane minimum", 420, 300, { docked: false, width: 280, max: 280 }],
])("subagent pane %s", (_name, width, chat, expected) => {
  expect(subagentPaneLayout({ chat, width })).toEqual(expected)
})
