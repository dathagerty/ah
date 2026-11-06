// `ah dashboard`, and `ah debug tabs`, which shows the workspaces the
// dashboard maps tabs to and the titles ah gives them

import { Command, Option } from "@commander-js/extra-typings"
import { callServer, die, portOption, readStdin, serverUrl } from "../../platform/cli.ts"
import { readRex } from "../../platform/rex.ts"
import { currentAgent } from "../../platform/session.ts"
import { emptyRegistry, loadRegistry } from "../../core/registry.ts"
import { tabLabel } from "../../core/tabtitle/setter.ts"
import { currentTracker } from "../../core/tracker_api.ts"
import { rootFinder } from "../../core/workspace.ts"
import { dashboardStatus, ensureDashboardPage } from "./api.ts"
import { resolve } from "./workspace.ts"

export const dashboard = new Command("dashboard")
  .description("A window that follows the focused Rex tab")
  .action(function () {
    this.help()
  })

dashboard
  .command("review-comment")
  .summary("Take a skepsis comment into a PR's review inbox")
  .description(
    "skepsis's --send command when the dashboard opened it on a PR: reads skepsis's comment JSON from stdin and puts it in the PR's review inbox in the dashboard's PRs tab, to send on to GitHub or the tab's agent from there. Nothing goes to GitHub until the review is submitted.",
  )
  .requiredOption("--repo <owner/name>", "The PR's repo")
  .requiredOption("--number <n>", "The PR's number", (v) => Number.parseInt(v, 10))
  .addOption(portOption())
  .action(async ({ repo, number, port }) => {
    const payload =
      (await readStdin()) ?? die("ah: expected skepsis's comment JSON on stdin")
    const { status } = await callServer<{ status: string }>(
      serverUrl(port, "view/dashboard/review-comment"),
      { body: { repo, number, payload } },
    )
    console.log(status)
  })

dashboard
  .command("open")
  .summary("Open the dashboard window")
  .description(
    "Open the dashboard window, or if it's already open, keep that one. The window comes to the front when run from a shell, or from an agent whose Rex pane has focus with Rex the frontmost app; otherwise it opens or stays without taking focus.",
  )
  .addOption(
    new Option("--in <place>", "window: a window of its own, with its own Dock tile")
      .choices(["window"])
      .default("window"),
  )
  .option(
    "--no-other-display",
    "Leave the window where macOS puts it, instead of filling a display without the pointer",
  )
  .addOption(portOption())
  .action(async ({ port, otherDisplay }) => {
    console.log(await ensureDashboardPage(port, { otherDisplay }))
  })

dashboard
  .command("status")
  .summary("Show whether the dashboard is open")
  .description(
    "Show whether the dashboard is open, and this workspace's current tracker, which the dashboard shows.",
  )
  .addOption(portOption())
  .action(async ({ port }) => {
    console.log(await dashboardStatus(port))
    const agent = currentAgent()
    const path = agent && (await currentTracker(port, agent))
    if (path) console.log(`in the dashboard: ${path}`)
  })

/** `ah debug tabs` */
export const debugTabs = new Command("tabs")
  .summary("Show Rex's tabs as ah sees them")
  .description(
    "Read Rex's state once and print it, along with how long the read took, the workspaces it maps to, and each tab's title next to the title ah computes.",
  )
  .action(async () => {
    const start = performance.now()
    const rex = await readRex()
    const totalMs = Math.round(performance.now() - start)
    const state = resolve(rex, rootFinder(), null)
    // From the registry as last saved, which can trail the server's by a
    // moment; /tabtitles has the server's own
    const registry = loadRegistry() ?? emptyRegistry()
    const titles = rex.sessions
      .flatMap((s) => s.tabs)
      .map((tab) => {
        const ah = tabLabel(
          tab.blocks.map((t) => t.id),
          registry,
        )
        return {
          id: tab.id,
          shows: tab.name,
          ah,
          same: ah === undefined || ah === tab.name,
        }
      })
    console.log(JSON.stringify({ totalMs, state, titles, rex }, null, 2))
  })
