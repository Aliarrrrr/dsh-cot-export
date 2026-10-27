# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-10-27

### Added

- **`html` format (the replay view)**, replacing the need for a separate
  `dsh-replay` CLI: a self-contained timeline with one card per turn and one block
  per step, collapsible reasoning / answer / tool sections, an Expand all /
  Collapse all pair, turn anchors, and a light/dark stylesheet driven by
  `prefers-color-scheme`. No external assets; the only script is the fixed
  expand/collapse handler; every piece of session text is HTML-escaped, so
  reasoning that contains markup cannot inject anything.
- **Tool results in the extracted model**: `tool/call` events are paired with
  their `tool/result` by call id, and each step now carries `tool_results`
  (`call_id`, `name`, `is_error`, `chars`, `text`, `truncated`). Results are capped
  at 4000 characters per entry and marked when cut. This is what makes the HTML
  view a real trajectory rather than reasoning only.
- `tool_calls[]` blocks keep their `id`, so the JSON output can be joined against
  the results too.
- `htm` and `replay` are accepted as format aliases for `html`; the format
  control, `/cot html`, the tool's `format` argument and the route's
  `format=html` all reach it.

### Changed

- The header panel is 360px wide to fit five format buttons.

## [1.2.1] — 2026-10-27

### Fixed

- **Downloading opened the wrong thing.** Clicking 下载 used to navigate the shell
  to the `/api/cot.export` URL (a hidden anchor, and the fallback whenever the
  save picker was unavailable). In the Desktop shell that is a document
  navigation, so the artifact could open as a page or raise the shell's own
  download prompt instead of saving a file. The header action no longer navigates
  to the route at all: it fetches the bytes (`inline=1`) and hands them to a
  detached anchor with a blob URL and the exact artifact name, which is an
  ordinary file download.
- **Choosing a location is now an explicit, separate action.** 下载 is a plain
  download with no dialog; 另存为… appears only when the shell implements the save
  picker and asks where to put the file. Neither path writes a second artifact on
  the Host.
- A failed transfer now shows the reason plus the artifact's on-disk path instead
  of failing silently, and both buttons show a preparing state while the bytes
  are in flight.

## [1.2.0] — 2026-10-27

### Added

- **Explicit format selector**: the panel now shows `Markdown · JSON · JSONL ·
  Text` as a segmented control. Switching re-exports the same session in the
  chosen format and refreshes the panel in place, so the active format is always
  visible; the choice is remembered between sessions.
- **Save location**: **保存到** shows the folder the artifact really landed in and
  **更改** opens the host directory picker (`uiWorkspace.pickDirectory`). The
  chosen folder is sent to the Host as `&dir=` and remembered; **默认** returns to
  the configured default.
- **`dir` route parameter** — writes the artifact into a caller-chosen folder;
  responses report `output_dir`.
- **`inline=1` route parameter** — streams the bytes of an artifact that was
  already written. Downloads use it, so saving a file no longer creates a second
  copy on the Host.
- Downloads use the shell's save-file picker (`showSaveFilePicker`) when present,
  so the user chooses the exact destination; the plain download link remains the
  fallback.

### Changed

- The panel now follows the host's real design vocabulary instead of generic
  chrome: `--dsw-font-*` shorthands, `--dsw-radius-*`, `--dsw-elevation-prominent`,
  `--dsw-alias-button-info-fill` / `-info-label` primary actions,
  `--dsw-alias-interactive-bg-hover` hover, `--dsw-focus-ring-color` focus rings,
  and host scrollbar tokens. No literal colours anywhere.
- The panel opens immediately and stays open while re-exporting, showing a
  progress bar instead of closing; the file name and directory are separated, and
  the directory is middle-ellipsised.
- Action buttons carry stable `data-action` attributes for testing and tooling.

### Fixed

- The folder returned by the directory picker was not used by the export that
  followed it (stale state); it is now passed explicitly to the request.

## [1.1.0] — 2026-10-27

### Added

- **`mode=review` on the export route**: `GET /api/cot.export?mode=review` writes
  the CoT artifact plus `REVIEW.md` and returns both paths, the window count and
  the delegation prompt, so the header action can build the review package
  without a second round trip.
- **Provenance**: every artifact frontmatter, tool result and route payload now
  carries `exporter: dsh-cot-export@<version>`, read from the package manifest, so
  a file on disk can be traced to the build that produced it.
- **Self-contained test harnesses** in `selftest/`: an integration harness that
  drives the real `apply()` against decoded session logs (tools, `/cot`, every
  route mode, output-schema validation) and a client wiring/state-machine test.
  Both bootstrap their dependency stubs in a throwaway directory, so a clean
  checkout runs them with no install step.

### Changed

- **Header action redesigned**: the cramped chip became an anchored result panel
  with turn/step/character/token numbers, a click-to-copy path, and follow-up
  actions (copy, download, re-export as JSONL, build the review package). It has
  explicit loading and error states, Escape and outside-click dismissal, keyboard
  focus rings, and positions itself before paint so it never flashes at fallback
  coordinates. Styling still uses `--dsw-alias-*` tokens only.
- The `cot_export` tool hint now matches the chosen format (the turn index only
  exists in Markdown).
- Tool, route and artifact values gained the `exporter` field; the artifact
  schema stays `dsh-cot/v1` because the change is additive.

## [1.0.0] — 2026-10-27

### Added

- One-click **CoT** header button backed by the authenticated exact Fetch route
  `GET /api/cot.export`.
- `/cot` slash command with `json`, `surface`, `latest`, `<id-or-prefix>` and
  `review [focus]` variants.
- `cot_export` and `cot_review` agent tools; `cot_review` writes `REVIEW.md`
  with the review rubric, a window plan and a ready-to-pass delegation prompt.
- Embedded `cot-review` skill so any session can load the same rubric.
- Markdown (frontmatter + turn index), JSON, JSONL and plain-text formats.
- Compaction-hidden reasoning is preserved and marked `superseded`; fork-inherited
  steps are marked `inherited`; descendant subagent sessions can be exported as a
  tree with an `INDEX.md`.
- Configurable output directory, format, scope, cross-session policy, route path
  and skill toggle.
- Aggregate-bundle double-mount guard in `cordis.patch.yml`.

### Packaging

- Standard Cordis bundle manifest (`dsh.bundle.patch`) with Host and Client
  halves, locale dictionaries and an icon.
- 16 unit tests running on `node --test` with no installed dependencies.
- GitHub Actions CI (Node 22.19 / 24) and tag-driven GitHub Release that attaches
  the packed `.tgz`.
