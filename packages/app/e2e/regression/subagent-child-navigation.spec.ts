import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client/promise"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { expectPath, SERVER, sessionHref } from "../utils/app"
import { currentSession } from "../utils/mock-server"
import { assistantMessage, session, sessionID, setupTimeline, textPart, userMessage } from "../utils/timeline"
import { expectSessionTitle } from "../utils/waits"
import { mockWorkspace } from "../utils/workspace"

const directory = "C:/OpenCode/SubagentNavigation"

const projectID = "proj_subagentnavigation"

const serverOrigin = SERVER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const apiRoute = (path: string) => new RegExp(`^${serverOrigin}${path}(\\?|$)`)

const parentID = "ses_subagent_parent"

const childID = "ses_subagent_child"

const runningChildID = "ses_subagent_running"

const grandchildID = "ses_subagent_grandchild"

const greatGrandchildID = "ses_subagent_great_grandchild"

const parentTitle = "Parent session"

const childTitle = "Subagent child session"

const runningChildTitle = "Running subagent session"

const grandchildTitle = "Nested subagent session"

const greatGrandchildTitle =
  "Deep research subagent session investigating a very long chain of agent registry failures and navigation breadcrumbs"

// Child session pages derive their heading from the task part that spawned them.
const taskDescription = "Inspect child navigation"

test.use({ viewport: { width: 1440, height: 900 } })

test("navigates to a subagent child session missing from the session list", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)

  await expectSessionTitle(page, taskDescription)
  await expect(page.getByRole("heading", { name: parentTitle })).toHaveCount(0)

  await expect(page.getByRole("button", { name: "Toggle review", exact: true })).toBeVisible()

  // Escape returns to the parent session.
  await page.keyboard.press("Escape")
  await Promise.all([expect(page).toHaveURL(sessionHref(parentID)), expectSessionTitle(page, parentTitle)])
})

test("keeps the parent title anchored when opening a subagent", async ({ page }) => {
  await setup(page)

  for (const direction of ["ltr", "rtl"] as const) {
    await page.goto(sessionHref(parentID))
    await page.evaluate((direction) => (document.documentElement.dir = direction), direction)
    await expectSessionTitle(page, parentTitle)

    // The title first renders in the loading header, which the timeline replaces once messages arrive.
    // Measuring before then can read the detached heading, whose empty bounds put the start at 0.
    const card = page.locator(`a[href="${sessionHref(childID)}"]`)
    await expect(card).toBeVisible()
    const start = await titleInlineStart(
      page.locator("[data-session-title]").getByRole("heading", { name: parentTitle }),
    )

    await card.click()
    await openFullSession(page)
    await expectSessionTitle(page, taskDescription)

    const breadcrumb = page.locator('[data-slot="session-title-parent"]')

    await expect(breadcrumb).toHaveText(parentTitle)
    await expect.poll(() => titleInlineStart(breadcrumb)).toBeCloseTo(start, 0)
    await breadcrumb.click()
    await expectSessionTitle(page, parentTitle)
    await expect
      .poll(() => titleInlineStart(page.locator("[data-session-title]").getByRole("heading", { name: parentTitle })))
      .toBeCloseTo(start, 0)
  }
})

test("opens a subagent card in a pane beside the transcript", async ({ page }) => {
  await setupPane(page)
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  await page.locator(`a[href="${sessionHref(childID)}"]`).click()

  // The main transcript stays where it is; the subagent's own transcript shows beside it.
  await expectPath(page, sessionHref(parentID))
  await expect(page.getByRole("heading", { name: parentTitle })).toBeVisible()
  const pane = page.getByRole("complementary", { name: "Subagents" })
  await expect(pane.getByText("Child transcript text")).toBeVisible()

  await pane.getByRole("button", { name: "Back", exact: true }).click()
  // The running subagent comes before the finished one.
  const rows = pane.getByRole("listitem")
  await expect(rows).toHaveText([new RegExp(runningChildTitle), new RegExp(childTitle)])
  // Back leaves focus on the row of the subagent just left.
  await expect(pane.getByRole("button", { name: new RegExp(childTitle) })).toBeFocused()

  await rows.filter({ hasText: runningChildTitle }).getByRole("button").click()
  const interrupt = pane.getByRole("button", { name: "Interrupt subagent" })
  await expect(interrupt).toBeVisible()
  const interrupted = page.waitForRequest(
    (req) => req.method() === "POST" && apiRoute(`/api/session/${runningChildID}/interrupt`).test(req.url()),
  )
  await interrupt.click()
  await interrupted
  await pane.getByRole("button", { name: "Back", exact: true }).click()

  await rows.filter({ hasText: childTitle }).getByRole("button").click()
  await expect(pane.getByText("Child transcript text")).toBeVisible()
  await pane.getByRole("button", { name: "Open full session" }).click()
  await expectPath(page, sessionHref(childID))
  await expectSessionTitle(page, taskDescription)
  // The pane would only list the subagent's own, so it closes with the way in.
  await expect(pane).toHaveCount(0)
})

test("lists a finished subagent's own subagents before it is opened", async ({ page }) => {
  await mockWorkspace(page, {
    name: "SubagentNavigation",
    sessions: [
      { id: parentID, title: parentTitle, created: 1700000000000 },
      { id: childID, title: childTitle, created: 1700000001000, parentID },
      { id: grandchildID, title: grandchildTitle, created: 1700000002000, parentID: childID },
    ],
    pageMessages: (id) => ({ items: id === parentID ? parentMessages() : [] }),
    seed: { tabs: [parentID] },
  })
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  await page.getByRole("button", { name: "Toggle subagents" }).click()
  await expect(page.getByRole("complementary", { name: "Subagents" }).getByRole("listitem")).toHaveText([
    new RegExp(childTitle),
    new RegExp(grandchildTitle),
  ])
})

test("opens a subagent card that is not this session's own on its route", async ({ page }) => {
  // A fork copies its original's cards, whose subagents belong to the original and resolve by ID on click.
  const originalID = "ses_subagent_original"
  const copiedClosedID = "ses_subagent_copied_closed"
  const copiedOpenID = "ses_subagent_copied_open"
  const copiedClosedTitle = "Copied subagent session"
  const copiedOpenTitle = "Second copied subagent session"
  await mockWorkspace(page, {
    name: "SubagentNavigation",
    sessions: [
      { id: parentID, title: parentTitle, created: 1700000000000 },
      { id: childID, title: childTitle, created: 1700000000500, parentID },
      { id: originalID, title: "Original session", created: 1700000001000 },
      { id: copiedClosedID, title: copiedClosedTitle, created: 1700000002000, parentID: originalID },
      { id: copiedOpenID, title: copiedOpenTitle, created: 1700000003000, parentID: originalID },
    ],
    pageMessages: (id) => ({
      items:
        id === parentID
          ? parentMessages(copiedClosedID, copiedOpenID)
          : id === childID
            ? childMessages()
            : [],
    }),
    seed: { tabs: [parentID] },
  })
  const pane = page.getByRole("complementary", { name: "Subagents" })
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  const resolvedClosed = page.waitForRequest(apiRoute(`/api/session/${copiedClosedID}`))
  await page.locator(`a[href="${sessionHref(copiedClosedID)}"]`).click()
  await resolvedClosed
  await expectPath(page, sessionHref(copiedClosedID))
  await expectSessionTitle(page, copiedClosedTitle)
  await expect(pane).toHaveCount(0)

  // Returning to the parent and opening its own subagent pane keeps that pane open across a copied card's navigation.
  await page.goBack()
  await Promise.all([expectPath(page, sessionHref(parentID)), expectSessionTitle(page, parentTitle)])
  await page.getByRole("button", { name: "Toggle subagents" }).click()
  await pane.getByRole("listitem").filter({ hasText: childTitle }).getByRole("button").click()
  await expect(pane.getByText("Child transcript text")).toBeVisible()

  const resolvedOpen = page.waitForRequest(apiRoute(`/api/session/${copiedOpenID}`))
  await page.locator(`a[href="${sessionHref(copiedOpenID)}"]`).click()
  await resolvedOpen
  await expectPath(page, sessionHref(copiedOpenID))
  await expectSessionTitle(page, copiedOpenTitle)
  await expect(pane).toBeVisible()

  await page.goBack()
  await Promise.all([expectPath(page, sessionHref(parentID)), expectSessionTitle(page, parentTitle)])
  await expect(pane.getByText("Child transcript text")).toBeVisible()
})

test("toggles the subagent pane from the header and the keyboard", async ({ page }) => {
  await setupPane(page)
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  const toggle = page.getByRole("button", { name: "Toggle subagents" })
  const pane = page.getByRole("complementary", { name: "Subagents" })
  await expect(pane).toHaveCount(0)

  await toggle.click()
  await expect(pane).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(pane.getByRole("listitem")).toHaveCount(2)

  await pane.getByRole("button", { name: "Close subagents" }).click()
  await expect(pane).toHaveCount(0)
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(toggle).toBeFocused()

  // The test browser reports Windows, so the app's modifier is Control on every host.
  await page.keyboard.press("Control+Shift+E")
  await expect(pane).toBeVisible()
})

test("navigates from a running subagent card and hides background controls in the child", async ({ page }) => {
  const runningChildID = "ses_running_child"
  await setupTimeline(page, {
    settings: { timelineDetail: { ...timelinePresets[2].value, subagents: { placement: "separate" } } },
    sessionMessages: [
      { id: "msg_user", type: "user", text: "Run it", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_subagent",
            name: "subagent",
            state: {
              status: "running",
              input: { description: "Inspect code" },
              metadata: { status: "running", sessionID: runningChildID },
            },
            time: { created: 2 },
          },
        ],
        time: { created: 2 },
      },
    ],
    sessions: [session(), session({ id: runningChildID, parentID: sessionID, title: "Sleep for 5 minutes" })],
    sessionStatus: { [sessionID]: { type: "busy" }, [runningChildID]: { type: "busy" } },
  })
  const hint = page.getByRole("button", { name: /move running work to the background/i })
  await expect(hint).toBeVisible()
  await page.locator('[data-component="task-tool-card"]').click()
  await openFullSession(page)
  await expect(page).toHaveURL(new RegExp(`/session/${runningChildID}$`))
  await expect(hint).toHaveCount(0)
})

test("opens a directly linked nested subagent in its root session tab", async ({ page }) => {
  await setup(page, undefined, 1)
  await page.goto(sessionHref(grandchildID), { waitUntil: "domcontentloaded" })

  await expect(page.locator('[data-slot="session-title-parent"]')).toHaveText(childTitle)
  await expect(page.locator('[data-slot="session-title-child"]')).toHaveText(grandchildTitle)
  const tabs = page.locator('[data-slot="titlebar-tabs"] [data-titlebar-tab-slot]')
  await expect(tabs.locator(`a[href="${sessionHref(grandchildID)}"]`)).toHaveCount(1)
  await expect(tabs).toHaveCount(1)
  await expect(tabs.locator('[data-slot="tab-title"]')).toHaveText(parentTitle)
})

test("shows the full ancestor path and navigates to an earlier subagent", async ({ page }) => {
  await setup(page, undefined, 2)
  await page.goto(sessionHref(greatGrandchildID), { waitUntil: "domcontentloaded" })

  await expect(page.locator("[data-timeline-virtual-content]")).toBeAttached()
  const header = page.locator("[data-session-title]")
  await expect(header.locator('[data-slot="session-title-ancestor"]')).toHaveText([parentTitle, childTitle])
  await expect(header.locator('[data-slot="session-title-parent"]')).toHaveText(grandchildTitle)
  await expect(header.getByRole("heading", { name: greatGrandchildTitle })).toBeVisible()
  // Project, each ancestor and the title are all split by the same slash.
  const separators = header.locator('[data-slot="session-title-separator"]')
  await expect(separators).toHaveCount(4)
  await expect(separators.locator('[data-component="slash"]')).toHaveCount(4)

  await header.getByRole("button", { name: childTitle, exact: true }).click()
  await expect(page).toHaveURL(sessionHref(childID))
  await expect(page.locator("[data-session-title]").getByRole("heading", { name: childTitle })).toBeVisible()
  await expect(page.locator('[data-slot="titlebar-tabs"] [data-titlebar-tab-slot]')).toHaveCount(1)
})

test("keeps the active nested session visible in a narrow desktop header", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 720 })
  await setup(page, undefined, 2)
  await page.goto(sessionHref(greatGrandchildID), { waitUntil: "domcontentloaded" })

  const header = page.locator("[data-session-title]")
  const heading = header.getByRole("heading", { name: greatGrandchildTitle })
  const separator = header.locator('[data-slot="session-title-ancestors"] + [data-slot="session-title-separator"]')
  await expect(header.locator('[data-slot="session-title-ancestor"]')).toHaveText([parentTitle, childTitle])
  await expect(heading).toBeInViewport()
  // The header stays one row, so the trail still ends in a separator before the title.
  await expect(separator).toBeVisible()
  const bounds = await heading.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(820)

  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
  await expect(heading).toBeInViewport()
  await expect(separator).toBeVisible()

  const root = header.locator(`[data-slot="session-title-ancestor"][data-session-id="${parentID}"]`)
  await root.focus()
  await expect(root).toBeFocused()
  await root.press("Enter")
  await expect(page).toHaveURL(sessionHref(parentID))
})

test("restores the project name after closing review in a nested session", async ({ page }) => {
  await page.setViewportSize({ width: 890, height: 900 })
  await mockWorkspace(page, {
    name: "Project with a moderately long display name",
    directory,
    sessions: [
      { id: parentID, title: "Root session outlining repository-wide change analysis and implementation" },
      { id: childID, parentID, title: "Intermediate agent examining architecture and regression coverage" },
      { id: grandchildID, parentID: childID, title: "Review repository" },
    ],
  })
  await page.goto(sessionHref(grandchildID))
  await expect(page.locator("[data-timeline-virtual-content]")).toBeAttached()
  const header = page.locator("[data-session-title]")
  const row = header.locator(".session-header-layout")
  const project = header.locator('[data-slot="session-location-project"]')
  const review = page.getByRole("button", { name: "Toggle review", exact: true })
  await expect(project).toBeVisible()
  const width = await row.evaluate((element) => element.getBoundingClientRect().width)
  await header.screenshot({ path: test.info().outputPath("nested-header-before-review.png") })

  await review.click()
  await expect(project).toBeHidden()
  await review.click()
  await expect.poll(() => row.evaluate((element) => element.getBoundingClientRect().width)).toBe(width)
  await expect(project).toBeVisible()
  await expect(header.getByRole("heading", { name: "Review repository", exact: true })).toBeVisible()
  await header.screenshot({ path: test.info().outputPath("nested-header-restored.png") })
})

test("shows parent lineage while the child timeline loads", async ({ page }) => {
  await setup(page)
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route(apiRoute(`/api/session/${childID}/message`), async (route) => {
    requested.resolve()
    await release.promise
    await route.fallback()
  })

  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)
  await page.locator(`a[href="${sessionHref(childID)}"]`).click()
  await requested.promise
  await openFullSession(page)
  await expect(page).toHaveURL(sessionHref(childID))
  // The pane started the held load, and the route joins it instead of making its own, so the route's header and its
  // missing timeline are what show that the load is pending.
  await Promise.all([
    expect(page.locator("[data-timeline-virtual-content]")).toHaveCount(0),
    expect(page.locator('[data-slot="session-title-parent"]')).toHaveText(parentTitle),
    expect(page.locator('[data-slot="session-title-child"]')).toHaveText(childTitle),
  ]).finally(() => release.resolve())
  await expectSessionTitle(page, taskDescription)
})

// Desktop opens a subagent card in the pane; a narrow screen has no pane, so the card still opens the session in place.
test("keeps the parent visible while the child session resolves", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await setup(page)
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route(apiRoute(`/api/session/${childID}`), async (route) => {
    requested.resolve()
    await release.promise
    await route.fallback()
  })
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  await page.locator(`a[href="${sessionHref(childID)}"]`).click()
  await requested.promise
  await Promise.all([expect(page).toHaveURL(sessionHref(parentID)), expectSessionTitle(page, parentTitle)]).finally(
    () => release.resolve(),
  )

  // A narrow screen has no timeline header, so its tab names the session by its own title.
  await expectSessionTitle(page, childTitle)
})

test("keeps the parent tab selected while a loaded child session resolves", async ({ page }) => {
  await setup(page)
  await openChildFromParent(page)
  await expectSessionTitle(page, taskDescription)
  await page.goBack()
  await Promise.all([expect(page).toHaveURL(sessionHref(parentID)), expectSessionTitle(page, parentTitle)])

  // Holds only what the route asks for after "Open full session"; the pane's own loads pass.
  let holding = false
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route(apiRoute(`/api/session/${childID}`), async (route) => {
    if (!holding) return route.fallback()
    requested.resolve()
    await release.promise
    await route.fallback()
  })

  const parentTab = page.locator("[data-titlebar-tab-slot]", {
    has: page.locator('[data-slot="tab-title"]', { hasText: parentTitle }),
  })

  await page.locator(`a[href="${sessionHref(childID)}"]`).click()
  const pane = page.getByRole("complementary", { name: "Subagents" })
  await expect(pane.getByText("Child transcript text")).toBeVisible()
  holding = true
  await openFullSession(page)
  await Promise.all([requested.promise, expect(page).toHaveURL(sessionHref(childID))])
  await Promise.all([
    expect(parentTab).toHaveAttribute("data-active", "true"),
    expect(page.locator('[data-slot="session-title-parent"]')).toHaveText(parentTitle),
  ]).finally(() => release.resolve())
  await expectSessionTitle(page, taskDescription)

  const home = page.getByRole("button", { name: "Home" })
  await home.click()
  await expect(page).toHaveURL("/")
  const childTab = page.locator(`[data-slot="titlebar-tabs"] a[href="${sessionHref(childID)}"]`)
  await expect(childTab).toHaveCount(1)
  await childTab.click()
  await Promise.all([expect(page).toHaveURL(sessionHref(childID)), expectSessionTitle(page, taskDescription)])
})

test("shows the not found fallback when the viewed session is deleted", async ({ page }) => {
  const events: OpenCodeEvent[] = []
  await setup(page, () => events.splice(0, 1))
  await openChildFromParent(page)
  await expectSessionTitle(page, taskDescription)

  events.push({
    id: "evt_session_deleted",
    created: 1700000003000,
    type: "session.deleted",
    durable: { aggregateID: childID, seq: 1, version: 2 },
    location: { directory },
    data: { sessionID: childID },
  })

  await expect(page.getByText("This session cannot be found")).toBeVisible()
  await expect(page.getByRole("button", { name: "Close Tab", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: taskDescription })).toHaveCount(0)
})

test.describe("session ID links", () => {
  const target = "ses_0123456789abcdefghijklmnop"
  const missing = "ses_abcdefghijklmnopqrstuvwxyz"

  test("opens a verified session from agent prose or inline code with the keyboard", async ({ page }) => {
    await setupTimeline(page, {
      sessions: [session(), session({ id: target, title: "Linked session" })],
      tabs: [sessionID, target],
      messages: [
        userMessage(),
        assistantMessage([textPart("prt_session_links", `Visit ${target}.\n\nOr \`${target}\` to see the result.`)]),
      ],
    })
    // Visit the target so it is known to the shared session cache before checking its references.
    await page.locator(`[data-titlebar-tab-link][href$="/session/${target}"]`).click()
    await expectSessionTitle(page, "Linked session")
    await page.locator(`[data-titlebar-tab-link][href$="/session/${sessionID}"]`).click()
    await expectSessionTitle(page, "Timeline visual stability")
    const markdown = page.locator('[data-component="markdown"]').filter({ hasText: "Visit" })
    await expect(markdown).toHaveAttribute("data-markdown-ready", "")
    await expect(markdown.getByRole("button", { name: "Linked session", exact: true })).toHaveCount(2)
    await markdown
      .locator("p")
      .filter({ hasText: "Or" })
      .getByRole("button", { name: "Linked session", exact: true })
      .press("Enter")
    await expectPath(page, sessionHref(target))
    await expect(page.locator(`[data-titlebar-tab-link][href$="/session/${target}"]`)).toContainText("Linked session")
  })

  test("does not navigate to an ID that is absent from the current server", async ({ page }) => {
    await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([textPart("prt_session_missing", `See ${missing}.`)])],
    })
    const markdown = page.locator('[data-component="markdown"]').filter({ hasText: `See ${missing}.` })
    await expect(markdown).toHaveAttribute("data-markdown-ready", "")
    await expect(markdown.getByRole("button")).toHaveCount(0)
    await expect(markdown.locator("code")).toHaveText(missing)
    await expectPath(page, sessionHref(sessionID))
  })
})

async function setup(page: Page, events?: () => OpenCodeEvent[], nestedDepth: 0 | 1 | 2 = 0) {
  await mockWorkspace(page, {
    name: "SubagentNavigation",
    sessions: [
      { id: parentID, title: parentTitle, created: 1700000000000 },
      { id: childID, title: childTitle, created: 1700000001000, parentID },
      ...(nestedDepth >= 1
        ? [{ id: grandchildID, title: grandchildTitle, created: 1700000002000, parentID: childID }]
        : []),
      ...(nestedDepth >= 2
        ? [{ id: greatGrandchildID, title: greatGrandchildTitle, created: 1700000003000, parentID: grandchildID }]
        : []),
    ],
    pageMessages: (sessionID) => ({
      items: sessionID === parentID ? parentMessages() : sessionID === childID ? childMessages() : [],
    }),
    events,
    eventRetry: events ? 16 : undefined,
    seed: { tabs: [parentID] },
  })
  // The child session resolves by ID but is absent from the session list,
  // matching a subagent session that has not been loaded into the list cache yet.
  await page.route(apiRoute("/api/session"), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        data: [
          currentSession({
            id: parentID,
            slug: parentID,
            projectID,
            directory,
            title: parentTitle,
            version: "dev",
            time: { created: 1700000000000, updated: 1700000000000 },
          }),
        ],
        cursor: {},
      }),
    }),
  )
}

// A parent with a finished subagent whose transcript has text, and one still running.
async function setupPane(page: Page) {
  await mockWorkspace(page, {
    name: "SubagentNavigation",
    sessions: [
      { id: parentID, title: parentTitle, created: 1700000000000 },
      { id: childID, title: childTitle, created: 1700000001000, parentID },
      { id: runningChildID, title: runningChildTitle, created: 1700000002000, parentID },
    ],
    sessionStatus: { [runningChildID]: { type: "busy" } },
    pageMessages: (id) => ({
      items: id === parentID ? parentMessages() : id === childID ? childMessages() : [],
    }),
    seed: { tabs: [parentID] },
  })
}

function titleInlineStart(title: Locator) {
  return title.evaluate((element) => {
    const range = document.createRange()

    range.selectNodeContents(element)

    const bounds = range.getBoundingClientRect()

    return document.documentElement.dir === "rtl" ? bounds.right : bounds.left
  })
}

// The card opens its subagent in the pane beside the transcript; the pane's button opens the subagent's own session.
async function openFullSession(page: Page) {
  await page
    .getByRole("complementary", { name: "Subagents" })
    .getByRole("button", { name: "Open full session" })
    .click()
}

async function openChildFromParent(page: Page) {
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  const card = page.locator(`a[href="${sessionHref(childID)}"]`)
  await expect(card).toBeVisible()
  await card.click()
  await openFullSession(page)

  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${childID}$`), { timeout: 15_000 })
}

function childMessages(): SessionMessageInfo[] {
  const userID = "msg_child_user"

  return [
    userMessage(undefined, { id: userID }),
    assistantMessage([textPart("prt_child_text", "Child transcript text")], {
      id: "msg_child_assistant",
      parentID: userID,
    }),
  ]
}

function parentMessages(...subagentIDs: string[]): SessionMessageInfo[] {
  const userID = "msg_user_0001"
  const assistantID = "msg_assistant_0001"
  const ids = subagentIDs.length > 0 ? subagentIDs : [childID]

  return [
    {
      id: userID,
      type: "user",
      time: { created: 1700000000000 },
      text: "Delegate work to a subagent",
    },
    {
      id: assistantID,
      type: "assistant",
      time: { created: 1700000001000, completed: 1700000002000 },
      model: { id: "claude-opus-4-6", providerID: "opencode" },
      agent: "build",
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      content: ids.map((subagentID, index) => ({
        type: "tool" as const,
        id: `call_subagent_${String(index + 1).padStart(4, "0")}`,
        name: "subagent",
        time: {
          created: 1700000001000 + index,
          ran: 1700000001000 + index,
          completed: 1700000002000 + index,
        },
        state: {
          status: "completed" as const,
          input: { description: taskDescription, agent: "explore", prompt: "Inspect the delegated work." },
          content: [{ type: "text" as const, text: "Subagent finished" }],
          metadata: { sessionID: subagentID },
        },
      })),
    },
  ]
}
