# Komari Btop Minimal Theme Design

**Status:** Design ready for implementation review  
**Target:** Komari `1.5.1` public theme  
**Validated visual reference:** `.superpowers/brainstorm/manual-visual/content/layout-v23.html`

## Goal

Build a self-contained Komari theme for a private probe dashboard. The interface is deliberately sparse and terminal-like: a dark green scanline background, monospaced type, compact btop-style character bars, green for normal data, yellow for thresholds, and red only for offline or error states.

The theme has exactly two user-facing views:

1. A node list with the columns `NODE | CPU | MEM | DISK | NETWORK | TRAFFIC`.
2. A node detail page reached only by clicking a node name, with live core metrics and a latency chart on the same page.

There are no summary cards, totals, node-count statistics, fake `nodes/detail` tabs, throughput charts, geography, machine metadata, or update timestamps inside list rows.

## Package and Build Contract

The source project is a Vite `vanilla-ts` application with no runtime UI framework. It produces a Komari-compliant theme archive:

```text
komari-btop-minimal.zip
├── komari-theme.json
└── dist/
    ├── index.html
    └── assets/
```

The manifest is stored at the project root and uses:

```json
{
  "name": "Btop Minimal",
  "short": "btop-minimal",
  "description": "A minimal btop-inspired Komari monitor theme.",
  "version": "1.0.0",
  "author": "Tao"
}
```

`short` is intentionally unique, contains only permitted characters, and is not `default`. The built `dist/index.html` preserves these exact Komari replacement markers:

```html
<title>Komari Monitor</title>
<meta name="description" content="A simple server monitor tool." />
```

It also visibly retains the exact footer text `Powered by Komari Monitor.`. The theme does not replace `/admin` or `/terminal`, and declares no theme settings.

Vite builds with `base: "./"` so every emitted asset resolves correctly from the installed theme directory. A packaging script first builds, then creates `release/komari-btop-minimal.zip` with only `komari-theme.json` and the complete `dist/` directory at archive root. Source, tests, node modules, prototype files, and release directory contents are excluded from the ZIP.

## Source Layout

```text
src/
├── api/komari.ts          # REST, JSON-RPC, WebSocket transport and response parsing
├── domain.ts              # Public API shapes and normalized view-model types
├── format.ts              # Byte, speed, timestamp, percent, and bar formatting
├── traffic.ts             # Traffic-limit usage and threshold presentation rules
├── latency.ts             # Ping series normalization, filtering, scaling, and SVG segments
├── app.ts                 # Bootstrap, hash routing, data lifecycle, and state ownership
├── views/nodes.ts         # List markup and group-filter rendering
├── views/detail.ts        # Detail metrics, latency controls, and chart composition
├── styles.css             # Shared terminal visual system and responsive behavior
└── main.ts                # App entrypoint
tests/
├── format.test.ts
├── traffic.test.ts
└── latency.test.ts
scripts/
└── package.mjs            # Build output ZIP creation and archive-content validation
komari-theme.json
vite.config.ts
package.json
tsconfig.json
```

`app.ts` owns navigation and refresh lifecycle only. Transport, formatting, traffic computation, latency segmentation, and view rendering stay independently testable and do not fetch data themselves.

## Navigation and Shared Layout

Routes use the hash so the installed static theme remains independent of server-path configuration:

- `#/nodes` is the list view and is the default route.
- `#/nodes/<uuid>` is the detail view.
- An unknown UUID renders a minimal red `node not found` line and a working `← node list` control.

Clicking only a node-name button navigates to its detail route. Status dots, data cells, and empty table space do not navigate. Browser back/forward follows hash changes.

The shell is a centered terminal surface with a maximum content width of `1500px`, a near-black green scanline background, monospaced system fonts, and no cards or rounded panels. The top header keeps a static terminal prompt on the left and `last update: YYYY/MM/DD HH:mm:ss` on the right. The timestamp changes only after a successful live-data response; before one arrives it is `last update: --`.

The list filter control row and detail control row share an exact `18px` height, `14px` font size, and `18px` line height. This prevents a visible vertical jump when switching pages. On the list, the control row ends `22px` before the table header. On the detail page, the node name starts after a distinct `24px` gap below the control row.

The desktop grid intentionally remains one line per column. At narrow widths it horizontally scrolls rather than collapsing metrics into multiple lines; the theme is optimized for the owner’s monitoring screen rather than a general-purpose mobile dashboard.

## Node List

### Columns and rows

The table header and every row use the same six-column CSS grid:

```text
NODE | CPU | MEM | DISK | NETWORK | TRAFFIC
```

The `NODE` cell contains only one status dot and the node name. It never displays country, region, IP address, virtualization, tags, CPU name, or other machine metadata.

Each CPU, memory, and disk cell renders a single inline btop-style ten-cell bar followed by a percentage. It has no extra `cpu`, `mem`, or `disk` label inside the row.

- CPU percentage is `cpu.usage`, clamped to `0..100`.
- Memory percentage is `ram.used / ram.total * 100` when `ram.total > 0`.
- Disk percentage is `disk.used / disk.total * 100` when `disk.total > 0`.
- A value above `70%` renders its bar and percentage yellow; values at or below `70%` remain green.
- Online nodes with a missing metric use a muted `--`; offline or failed data uses red placeholders.

The status dot has only two states: green if the node UUID is present in the WebSocket `online` array and red otherwise. Resource load never changes the dot color.

Rows reserve a `35px` traffic-cell height plus consistent vertical padding. A node with no limit vertically centers its cumulative traffic in that same space; a node with a limit uses the first and second internal lines. Therefore limited and unlimited rows keep identical height and baseline alignment.

### Group filter

The control row starts with `all`, then one button per non-empty `group` value returned by `/api/nodes`, in first-seen order. Buttons are separated by dim green `·` characters. There is no `$ group:` prefix, square brackets, or `offline` filter.

Nodes with an empty group appear under `all` and do not create an extra filter. The selected filter uses bright green; inactive filters use muted green. Changing a filter only changes the visible rows and does not alter the live-data subscription.

### Network and traffic

`NETWORK` shows current download and upload in one line: `↓ <down>/s  ↑ <up>/s`. Komari reports speeds in bytes per second. Formatting uses binary units; `M` therefore means MiB/s. Each direction is independently yellow only when its raw rate is greater than `1 MiB/s` (`1,048,576` bytes/s); a rate at or below that threshold remains green. Offline or failed values are red.

`TRAFFIC` always shows cumulative direction totals on its first internal line as `↓ <totalDown>  ↑ <totalUp>`. It has two rendering modes:

1. **No configured limit:** `traffic_limit <= 0`, missing, or invalid. The first line is vertically centered; no second-line marker is rendered.
2. **Configured limit:** `traffic_limit > 0`. The second line contains a thin progress track and `<used> / <traffic_limit>`.

Usage follows Komari’s server-side `TrafficLimitType` semantics exactly:

| `traffic_limit_type` | used bytes |
| --- | --- |
| `sum` | `totalUp + totalDown` |
| `max` | `max(totalUp, totalDown)` |
| `min` | `min(totalUp, totalDown)` |
| `up` | `totalUp` |
| `down` | `totalDown` |
| missing or unknown | `max(totalUp, totalDown)` |

The visible progress fill is capped at `100%`, while the numeric used value remains uncapped. When usage is greater than `80%`, both the fill and `used / limit` text are yellow; at or below `80%` they are green. The page never displays the chosen accounting mode or an equivalent marker such as `Σ`, `MAX`, `MIN`, `↑`, or `↓` next to the limit itself. If a limit exists but traffic telemetry is unavailable, the second line retains its layout with an empty track and `-- / <limit>`.

## Live Data Lifecycle

At startup, the app fetches `/api/nodes` once to obtain node metadata, group membership, total capacity values, and traffic-limit configuration. It then re-fetches this endpoint every 60 seconds so metadata edits appear without a full reload.

Live telemetry comes from `GET /api/clients` as a browser WebSocket:

- Open the socket using the current page origin with `http` converted to `ws` and `https` converted to `wss`.
- On the list route, send `get` immediately and every 3 seconds.
- On a detail route, send `get <uuid>` immediately and every 3 seconds.
- Merge the response’s `data.online` and `data.data` into the normalized node state without discarding prior valid metadata.
- Update the global timestamp only after a response with `status: "success"` is parsed.
- Clear the interval and close the prior socket when routing away or reconnecting.
- Reconnect after 1, 2, 4, 8, 16, then 30 seconds; reset the delay after a successful message.

If the WebSocket is temporarily unavailable, the page retains the last valid display, continues reconnecting, and does not issue a many-node REST polling fan-out. Before any successful telemetry response, list metrics render as placeholders. This avoids both misleading synthetic data and unnecessary request load.

The live `Report` fields used are `cpu.usage`, `ram.total`, `ram.used`, `disk.total`, `disk.used`, `network.up`, `network.down`, `network.totalUp`, `network.totalDown`, and `updated_at`. Metadata totals from `/api/nodes` are only fallback values when the report’s matching total is absent or zero.

## Node Detail

The first control row contains `← node list` on the left and the two-state online indication on the right, sharing the list-control baseline. The node name appears on its own line below it. No extra location or machine descriptors appear.

Below the name, a compact single-row metric grid has these headings:

```text
CPU | MEM | DISK | NETWORK | TRAFFIC
```

The values are respectively percentage, `used / total`, `used / total`, current `↓ / ↑` speed, and cumulative `↓ / ↑` traffic. The detail page has no resource history, throughput chart, or additional dashboard panels. It uses the same green/yellow/red threshold rules as the list.

## Latency Chart

The detail page fetches latency data on entry, whenever the selected range changes, and every 60 seconds while the detail route remains open. It sends JSON-RPC to `POST /api/rpc2`:

```json
{
  "jsonrpc": "2.0",
  "method": "public:queryMetrics",
  "params": {
    "metric_key": "ping.latency_ms",
    "entity_id": "<uuid>",
    "hours": 24,
    "max_points": 480,
    "aggregation": "avg",
    "fill_empty": false
  },
  "id": 1
}
```

`series[].tags.task_id` identifies each Ping task. `GET /api/task/ping` provides the matching public task name and assigned client list. A task button uses that actual name; there are no hard-coded line names. If a returned series has no matching public task, its button label is `task <id>`. This supports installations whose labels are `telecom`, `unicom`, `mobile`, or any other owner-defined names.

The time buttons are exactly `1h`, `6h`, `24h`, `3d`, `7d`, and `30d`, mapped to `1`, `6`, `24`, `72`, `168`, and `720` hours. `24h` is the default. Changing time range preserves the active line set where those tasks still exist; if none survive, the selection returns to all available lines.

All tasks assigned to the node, plus any task represented by returned latency series, are visible by default. There is no `all` filter button and no empty-selection state. The task-button state machine is:

1. When all lines are visible, selecting one shows only that line.
2. When one or more, but not all, lines are visible, selecting a hidden line adds it.
3. When more than one line is visible, selecting a visible line removes it.
4. When exactly one line is visible, selecting that same line restores all lines.

This guarantees that a user cannot cancel every line; a second click on `unicom` after filtering to only `unicom` restores all latency series.

The SVG chart is fixed at `280px` high, uses sparse horizontal grid lines, and scales the y-axis from `0` to the next `100ms` boundary at or above the greatest valid point, with a minimum ceiling of `300ms`. A time gap larger than one-and-a-half reported sample intervals starts a new path so missing samples are not connected.

Every visual line segment is colored by the latency along that interval:

- below `100ms`: green;
- from `100ms` through `200ms`: yellow;
- above `200ms`: red.

When an interval crosses `100ms` or `200ms`, the renderer calculates the linear threshold intersection and splits the SVG line there. It never paints the entire crossing segment one color. Invalid, negative, null, or non-finite values create gaps. Pointer movement shows a thin crosshair and a compact readout for only the currently visible task lines; moving away removes the crosshair and readout markers.

If no public tasks or latency points exist, the chart area stays minimal and displays `no latency records`. A failed ping request displays `latency unavailable` without replacing the rest of the detail page.

## Failure and Data-Compatibility Rules

All standard REST responses are unwrapped from `{ status, message, data }`; JSON-RPC responses use `result`. A non-success status, malformed payload, network failure, or JSON-RPC error is handled locally and never crashes the router.

- Missing `/api/nodes` data renders one minimal red `unable to load nodes` line and continues a 60-second metadata retry.
- Missing telemetry for an online node uses muted placeholders, not fabricated zero values.
- A UUID absent from the WebSocket online list is offline even if a previous report remains cached; its dot and unavailable live fields are red.
- Cached cumulative traffic may remain visible in red for an offline node only when it came from a valid previous report; otherwise it is `--`.
- Unknown API fields are ignored. Required fields that are absent follow the placeholder rules above.
- An unrecognized traffic-limit type defaults to the server-compatible `max` behavior.
- Requests tied to a prior node route, range, or latency refresh are aborted or discarded before they can overwrite newer state.

## Validation Strategy

Pure module tests run with Vitest and cover:

1. all five traffic-limit accounting modes plus unknown-type fallback;
2. no-limit versus limit detection, progress capping, and the `>80%` yellow boundary;
3. CPU/memory/disk warning thresholds and the independent `>1 MiB/s` network-direction threshold;
4. byte and speed formatting, percentages, bars, and unavailable/offline placeholders;
5. latency line-selection transitions, including `all → unicom → all` and the prohibition on an empty selection;
6. latency threshold crossing calculations and segment color classification at `100ms` and `200ms`;
7. range mapping and the time-gap rule that prevents false connected lines.

The implementation validation sequence is:

1. run type checking and unit tests;
2. run the production Vite build;
3. inspect the generated `dist/index.html` for the required title, description, and footer text;
4. build the ZIP and list its entries to verify the required root structure;
5. load the built output against `https://i.taos.one/` in a browser, verify live list data, a limited and an unlimited traffic row when available, route navigation, and the latency filtering behavior;
6. install the ZIP through the Komari theme workflow and repeat the live smoke test.

## Repository Delivery

The current local Git repository has no commit, remote, or configured identity. Implementation will keep project files under version control locally but will not create a commit, branch, repository, or push until the user supplies an existing GitHub repository URL or explicitly authorizes creating the destination repository and its name. The release ZIP remains local until that delivery step is complete.




