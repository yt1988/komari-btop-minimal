# Komari Btop Minimal Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, validate, package, and publish a minimal btop-style Komari `1.5.1` theme with live node data and interactive latency history.

**Architecture:** A Vite vanilla TypeScript single-page application separates Komari transport, normalized domain data, pure formatting/calculation utilities, and DOM views. Hash routing keeps the static theme independent of server-path configuration; a reconnecting `/api/clients` WebSocket supplies live reports while REST and JSON-RPC supply metadata and latency history.

**Tech Stack:** TypeScript, Vite, Vitest, native DOM/SVG APIs, browser WebSocket and Fetch APIs, `archiver` for release ZIP creation, and no runtime UI framework.

**Spec:** `docs/superpowers/specs/2026-10-11-komari-btop-theme-design.md`

## Global Constraints

- Target Komari version is `1.5.1` and the installed archive root contains only `komari-theme.json` and `dist/`.
- `dist/index.html` preserves `<title>Komari Monitor</title>`, `<meta name="description" content="A simple server monitor tool." />`, and visible `Powered by Komari Monitor.`.
- The list columns are exactly `NODE | CPU | MEM | DISK | NETWORK | TRAFFIC`; rows remain single-line and have no summary cards or row timestamps.
- Node status dots are green for WebSocket-online UUIDs and red otherwise; load never changes dot color.
- Network directions turn yellow only above `1 MiB/s`; traffic progress turns yellow only above `80%`; CPU, memory, and disk turn yellow above `70%`.
- Traffic accounting supports `sum`, `max`, `min`, `up`, and `down`; unknown types use `max`; the accounting type is never displayed.
- Group filters are dynamic non-empty node groups plus `all`, separated by `·`, with no `offline` option, `$ group:` prefix, or square brackets.
- Detail latency range options are exactly `1h`, `6h`, `24h`, `3d`, `7d`, and `30d`, with `24h` selected initially and no empty line-selection state.
- Latency lines split at `100ms` and `200ms` crossings so each segment is colored green, yellow, or red by its own value.
- The current user explicitly authorized creating a new GitHub repository; commits and push happen only after local verification succeeds.

## File Map

Create the following focused files:

```text
.gitignore                       # generated/local files excluded from Git
package.json                     # scripts and dev dependencies
package-lock.json                # locked dependency graph
tsconfig.json                    # strict TypeScript configuration
vite.config.ts                   # relative asset base and build output
index.html                       # source HTML with Komari marker strings and footer
komari-theme.json                # Komari theme manifest
src/main.ts                      # browser entrypoint
src/app.ts                       # route state, refresh lifecycle, and application state
src/domain.ts                    # API and normalized view-model types
src/api/komari.ts                # REST, JSON-RPC, WebSocket, and parser boundaries
src/format.ts                    # pure display formatting and color thresholds
src/traffic.ts                   # pure traffic-limit calculations
src/latency.ts                   # pure latency selection and SVG-segment calculations
src/views/nodes.ts               # node-list DOM rendering and group controls
src/views/detail.ts              # detail DOM rendering and latency controls
src/views/chart.ts               # SVG chart rendering and pointer readout
src/styles.css                   # terminal visual system
tests/format.test.ts             # formatting and threshold tests
tests/traffic.test.ts            # traffic accounting and progress tests
tests/latency.test.ts            # line selection and threshold segmentation tests
tests/api.test.ts                # response normalization fixtures
scripts/package.mjs              # build, ZIP, and archive-entry validation
docs/superpowers/plans/...       # this implementation plan
docs/superpowers/specs/...       # approved design specification
```

The existing `.superpowers/` history and root `layout-v*.html` visual snapshots remain local references and are not included in the release archive.

### Task 1: Scaffold the Installable Theme

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `komari-theme.json`
- Create: `src/main.ts`

**Interfaces:**
- Produces the `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run package` commands used by every later task.
- Produces an entrypoint that imports `src/styles.css` and mounts a `#app` element without yet fetching remote data.

- [ ] **Step 1: Define project scripts and dependencies.**

Create `package.json` with scripts whose commands are exact and composable:

```json
{
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "vite build",
    "package": "npm run build && node scripts/package.mjs"
  },
  "devDependencies": {
    "@types/node": "latest",
    "archiver": "latest",
    "typescript": "latest",
    "vite": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Configure strict TypeScript and relative Vite assets.**

Set `strict: true`, `noUncheckedIndexedAccess: true`, `noEmit: true`, `moduleResolution: "Bundler"`, and include `src` and `tests` in `tsconfig.json`. Set `base: "./"` and `build.outDir: "dist"` in `vite.config.ts`.

- [ ] **Step 3: Add the Komari source markers and manifest.**

Create `index.html` containing the exact title and description marker strings, `<div id="app"></div>`, and the visible footer text. Create `komari-theme.json` with `name: "Btop Minimal"`, `short: "btop-minimal"`, the approved description, version `1.0.0`, and author `Tao`.

- [ ] **Step 4: Add the smallest typed entrypoint.**

Create `src/main.ts` that imports `./styles.css` after the stylesheet exists, finds `#app`, and writes a plain `visitor@komari:~$ nodes` shell line. Add an empty `src/styles.css` containing the `#app` font/background baseline so the entrypoint is buildable.

- [ ] **Step 5: Install and run the scaffold checks.**

Run:

```text
npm install
npm run typecheck
npm run build
```

Expected: dependency installation succeeds, TypeScript exits `0`, and `dist/index.html` is emitted with the required title, description, and footer.

- [ ] **Step 6: Create the first local checkpoint.**

Run `git add .gitignore package.json package-lock.json tsconfig.json vite.config.ts index.html komari-theme.json src/main.ts src/styles.css` and commit with `chore: scaffold komari btop theme`. Do not add prototypes, `.superpowers/`, `dist/`, or `release/` at this checkpoint.

### Task 2: Define Domain Types and Komari Transport

**Files:**
- Create: `src/domain.ts`
- Create: `src/api/komari.ts`
- Create: `tests/api.test.ts`

**Interfaces:**
- `NodeMetadata` contains `uuid`, `name`, `group`, `memTotal`, `diskTotal`, `trafficLimit`, and `trafficLimitType`.
- `LiveReport` contains optional `cpuUsage`, `ram`, `disk`, `network`, and `updatedAt` values normalized from Komari `Report` JSON.
- `NodeState` contains `metadata: NodeMetadata`, `online: boolean`, `report: LiveReport | null`, and `lastReportAt: number | null`.
- `PingTask` contains `id: string`, `name: string`, `clients: string[]`, `defaultOn: boolean`, `type: string`, and `interval: number`.
- `LatencyQuery` contains `start`, `end`, `intervalSeconds`, and `series: LatencySeries[]`; each series contains `taskId`, `label`, and `points`.
- `fetchNodeMetadata(signal?: AbortSignal): Promise<NodeMetadata[]>`, `fetchPingTasks(signal?: AbortSignal): Promise<PingTask[]>`, and `fetchLatency(uuid: string, hours: number, signal?: AbortSignal): Promise<LatencyQuery>` are the public HTTP functions.
- `createLiveSocket(options: LiveSocketOptions): LiveSocketHandle` owns reconnecting WebSocket behavior; `LiveSocketHandle.stop(): void` closes timers and the socket.

- [ ] **Step 1: Write parser tests against actual Komari response envelopes.**

In `tests/api.test.ts`, fixture the standard `{status, data}` node/task responses, a `/api/clients` response with `data.online` and nested reports, and a JSON-RPC `public:queryMetrics` response with `series[].tags.task_id`. Assert that numeric totals, `traffic_limit_type`, `updated_at`, task names, and point timestamps survive normalization.

- [ ] **Step 2: Run the parser tests before implementation.**

Run `npm test -- tests/api.test.ts`. Expected: FAIL because the parser exports do not exist.

- [ ] **Step 3: Implement strict response normalization.**

In `src/api/komari.ts`, implement `unwrapStandardResponse`, `parseNodeMetadata`, `parsePingTasks`, `parseLiveSnapshot`, and `parseLatencyQuery`. Reject a non-`success` standard response, a JSON-RPC `error`, missing required UUIDs, or non-array latency points with an `Error` containing the endpoint name. Ignore unknown fields and use empty strings/zero-free optionals rather than fabricating telemetry values.

- [ ] **Step 4: Implement the three HTTP functions.**

Use same-origin relative paths and `fetch` with the passed `AbortSignal`. Call `/api/nodes`, `/api/task/ping`, and `/api/rpc2` respectively. The latency request must send `metric_key: "ping.latency_ms"`, `entity_id`, `hours`, `max_points: 480`, `aggregation: "avg"`, and `fill_empty: false`.

- [ ] **Step 5: Implement the reconnecting live socket.**

`createLiveSocket` must connect to the page origin with the current protocol converted to `ws` or `wss`, send `get` for `scope: "all"` or `get <uuid>` for `scope: "node"`, and invoke `onSnapshot` only for parsed success messages. Send the request immediately on open and let `app.ts` own the 3-second request interval. Reconnect after `1, 2, 4, 8, 16, 30` seconds, reset the delay after a successful message, and make `stop()` idempotent.

- [ ] **Step 6: Run parser and type checks.**

Run:

```text
npm test -- tests/api.test.ts
npm run typecheck
```

Expected: all parser tests pass and TypeScript reports no errors.

- [ ] **Step 7: Create the transport checkpoint.**

Commit `src/domain.ts`, `src/api/komari.ts`, and `tests/api.test.ts` with `feat: add komari data transport`.

### Task 3: Add Pure Formatting and Traffic Rules

**Files:**
- Create: `src/format.ts`
- Create: `src/traffic.ts`
- Create: `tests/format.test.ts`
- Create: `tests/traffic.test.ts`

- [ ] **Step 1: Write threshold and formatting tests first.**

Cover binary byte/speed formatting, percentage and btop bar output, unavailable values, CPU/memory/disk warning thresholds, the independent `>1 MiB/s` network threshold, all traffic accounting modes, capped progress, and the exact `>80%` warning boundary.

- [ ] **Step 2: Run the focused tests and confirm they fail.**

Run `npm test -- tests/format.test.ts tests/traffic.test.ts`; the first run must fail because the pure modules do not exist yet.

- [ ] **Step 3: Implement the pure modules.**

Keep thresholds and formatting deterministic and DOM-free. Use `--` for absent values, binary units for bytes and speeds, fixed-width character bars, and normalize negative/non-finite values as unavailable. `calculateTrafficUsage` must map `sum`, `max`, `min`, `up`, `down`, and unknown-to-`max` exactly as Komari does; no accounting label is returned for display.

- [ ] **Step 4: Run focused tests and typecheck.**

Run the two test files and `npm run typecheck`; all should pass before any view code is added.

- [ ] **Step 5: Create the formatting checkpoint.**

Commit the four files with `feat: add terminal formatting and traffic rules`.

### Task 4: Model Latency Selection and Threshold Segmentation

**Files:**
- Create: `src/latency.ts`
- Create: `tests/latency.test.ts`

- [ ] **Step 1: Write state-machine and segmentation tests first.**

Test `all → unicom → all`, adding a second line, removing one of several lines, preventing an empty selection, the six range mappings, invalid-point gaps, long-gap breaks, threshold colors, and exact splitting at `100ms` and `200ms` crossings.

- [ ] **Step 2: Run the latency tests and confirm they fail.**

Run `npm test -- tests/latency.test.ts`; the expected failure is missing latency exports.

- [ ] **Step 3: Implement normalized latency helpers.**

Implement range constants, `toggleVisibleTasks`, series filtering, y-axis ceiling, and a pure `buildLatencySegments` function that produces colored line segments with interpolated threshold intersections. Keep the output independent from SVG and DOM so it can be tested directly.

- [ ] **Step 4: Run latency tests and typecheck.**

Confirm all transitions and crossing calculations pass.

- [ ] **Step 5: Create the latency checkpoint.**

Commit `src/latency.ts` and `tests/latency.test.ts` with `feat: add latency selection model`.

### Task 5: Build Application State and Hash Routing

**Files:**
- Create: `src/app.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Define route and state ownership.**

Keep route parsing, node metadata, live snapshots, global refresh time, selected group, detail UUID, latency range, and visible task IDs in `app.ts`. Hash routes are `#/nodes` and `#/nodes/<uuid>`; unknown UUIDs render a red error with a functional `← node list` control.

- [ ] **Step 2: Add refresh lifecycle.**

Load metadata and ping tasks, open a reconnecting live socket, request all live data every three seconds, refresh metadata every 60 seconds, and refresh the selected detail latency query when its UUID/range changes. Abort or discard stale detail requests. Replace the header connection indicator with the last global refresh timestamp.

- [ ] **Step 3: Wire the entrypoint.**

Make `main.ts` mount the terminal shell and start the application without assuming any server path beyond same-origin API endpoints.

- [ ] **Step 4: Run typecheck.**

At this stage the shell may still contain placeholder views, but routing and lifecycle must compile cleanly.

### Task 6: Implement the Node List View and Shared Terminal Style

**Files:**
- Create: `src/views/nodes.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Render the approved list structure.**

Render only the group controls and the six-column header/rows. The node-name button is the only navigation target. Keep all data single-line, omit list timestamps, geography, machine details, overview totals, and `cpu/mem/disk` labels inside cells.

- [ ] **Step 2: Implement traffic variants without row jumps.**

Use a fixed-height traffic cell. Unlimited nodes show cumulative up/down centered in that cell; limited nodes show a compact progress bar and `used / limit` beneath it. Hide backend accounting type text. A missing unlimited limit still aligns vertically with limited rows.

- [ ] **Step 3: Implement group controls and thresholds.**

Use only `all` plus non-empty groups separated by low-contrast `·`, hide offline as a filter, and apply green/yellow/red only according to the approved data rules.

- [ ] **Step 4: Add the background, typography, and responsive grid.**

Follow the confirmed v23 prototype: near-black green scanlines, monospaced font, low-contrast separators, minimal borders, no cards or rounded panels, and shared `14px / 18px / 18px` control-row dimensions.

- [ ] **Step 5: Run typecheck and a production build.**

Inspect the emitted markup for the exact column order and absence of summary-card strings.

### Task 7: Implement Detail Metrics and Interactive Latency Chart

**Files:**
- Create: `src/views/detail.ts`
- Create: `src/views/chart.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Render the detail header and live core metrics.**

Use `← node list`, add visible spacing before the node-name line, keep the header/control dimensions identical to the list view, and render the same compact single-line core metrics without extra metadata or throughput charts.

- [ ] **Step 2: Render latency controls and preserve non-empty selection.**

Show task buttons for all assigned/returned lines, default to all lines and `24h`, toggle according to the pure state machine, and make a second click on the sole selected line restore all. Keep the exact six time buttons.

- [ ] **Step 3: Render the SVG chart and pointer readout.**

Use a 280px chart with sparse grid lines, threshold-split green/yellow/red paths, gap handling, and a compact pointer readout for visible lines only. No throughput visualization is added.

- [ ] **Step 4: Validate detail navigation and resize behavior.**

Run typecheck/build and manually inspect both hashes at desktop and narrow widths.

### Task 8: Add Error Degradation and Integration Coverage

**Files:**
- Modify: `src/app.ts`, `src/api/komari.ts`, and affected views
- Create or extend: `tests/api.test.ts` and focused view-safe tests where useful

- [ ] **Step 1: Test malformed and unavailable responses.**

Verify non-success envelopes, JSON-RPC errors, absent live telemetry, offline cached traffic, unknown traffic types, missing nodes, empty ping results, and stale detail requests all degrade locally without crashing the router.

- [ ] **Step 2: Implement minimal red/muted fallback states.**

Use `unable to load nodes`, `node not found`, `no latency records`, and `latency unavailable` exactly where specified; never fabricate zero telemetry.

- [ ] **Step 3: Run the complete unit suite and typecheck.**

Resolve only failures caused by this theme implementation.

### Task 9: Build, Package, and Verify the Installable Archive

**Files:**
- Create: `scripts/package.mjs`
- Modify: `package.json` if needed

- [ ] **Step 1: Implement archive validation.**

Build first, validate title/description/footer markers and required manifest fields, then create `release/komari-btop-minimal.zip` with only `komari-theme.json` and `dist/**` at archive root.

- [ ] **Step 2: Run all local verification commands.**

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run package`. List the archive entries and confirm no source, tests, `node_modules`, prototype, or nested project directory is included.

- [ ] **Step 3: Review the final diff.**

Use `git status`, `git diff --check`, and a concise file/diff review. Update this plan's checkboxes only after each step is evidenced.

### Task 10: Publish the Verified Project and Smoke-Test the Live Installation

**Files/Systems:**
- GitHub repository `yt1988/komari-btop-minimal`
- Local remote and Git identity
- `https://i.taos.one/`

- [ ] **Step 1: Create the authorized private repository.**

Create `yt1988/komari-btop-minimal` with the GitHub integration, add the returned remote locally, and set the already-verified user identity `Tao <yt1988@gmail.com>` only in this repository.

- [ ] **Step 2: Commit and push verified source.**

Create focused commits or one clean initial implementation commit after local verification, push `master`, and confirm the remote branch.

- [ ] **Step 3: Upload/install the ZIP and smoke-test.**

Use the available browser/UI workflow to install the generated archive at `https://i.taos.one/` if the site exposes the needed controls. Verify live list data, group controls, limited/unlimited traffic alignment, node navigation, range changes, line toggle behavior, and threshold colors. If the site requires credentials or deployment access unavailable to the agent, report that exact limitation rather than claiming success.

- [ ] **Step 4: Deliver concise handoff details.**

Report the GitHub URL, local ZIP path, verification commands and results, and any live-site limitation.


