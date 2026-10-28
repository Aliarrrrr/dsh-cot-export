# dsh-cot-export

English | [简体中文](README.zh.md)

Export a DSH session's **complete model chain of thought** — every reasoning
block the model emitted, turn by turn — to Markdown, JSON, JSONL or plain text,
in one click. The artifact is a normal file in the workspace, so any other
session, subagent or teammate can read and review it.

Three entry points, one pipeline:

| Entry point | Who calls it |
|---|---|
| Header button **CoT** (beside the session actions) | the user, one click |
| `/cot …` slash command | the user, from the composer |
| `cot_export` / `cot_review` tools | any agent, in any session |

## Install

Requirements: DSH **0.2.1-rc.3** (declared compatible in `package.json`) and
Node.js **22.19+ / 24+**.

```sh
# GitHub channel — no npm account required
dsh plugin --profile <profile> add github:Aliarrrrr/dsh-cot-export
```

`<profile>` is your DSH profile name (`web`, `desktop`, `headless`, …). The
profile re-composes through HMR; open a session and the **CoT** button, the
`/cot` command and the `cot_export` / `cot_review` tools are there.

Upgrade or remove:

```sh
dsh plugin --profile <profile> update dsh-cot-export
dsh plugin --profile <profile> remove dsh-cot-export
```

Every GitHub Release also carries a `dsh-cot-export-<version>.tgz` asset for
offline installs:

```sh
dsh plugin --profile <profile> add ./dsh-cot-export-1.0.0.tgz
```

## Compatibility

| DSH release | Status |
|---|---|
| `0.2.1-rc.3` | ✅ compatible (tested) |

The declaration lives in `package.json` under
`dsh.compatibility.dshReleases`; the manifest itself is a standard Cordis bundle
(`dsh.bundle.patch` → `cordis.patch.yml`) with both Host and Client halves.

## What lands on disk

Default location is `<workspace>/cot-exports/`, and every entry point returns
the absolute path.

```
cot-exports/fix-the-failing-test-aaaa1111-20261027-211759.md
```

The Markdown artifact starts with YAML frontmatter (session, workspace, preset,
models, export scope, counts, and an `exporter: dsh-cot-export@<version>`
provenance stamp) and a `## Index` table that maps each turn to its line number,
so a reviewer can page through a large export with the built-in `read` tool
instead of loading it whole.

Reasoning is verbatim. A step that compaction removed from the current model
context is still exported (scope `all`) and marked
`> ⚠ superseded — hidden from the current model context by compaction`; a step
inherited from a fork parent is marked `inherited`.

## Relationship to the built-in session-log export

DSH already ships **Download session log** (Session Header → More) and the
`/export` command (`@deepseek-ai/dsh-session-log-export`). That is a different
product, not a competitor:

| | Built-in `/export` ZIP | This plugin |
|---|---|---|
| What you get | The session's **raw event log** as plain `session.vN.jsonl`, every descendant's log, `media/<attachmentId>.<ext>` images, and `files/<digest>/<name>` uploads | A **derived, readable view** of the same log in five formats |
| Content | Every event: reasoning, tool calls and results, `system`/`developer` messages, `request/header` tool schemas, compaction, jobs, todos, approvals, command lifecycle | Reasoning blocks, user prompts, answers, tool calls, and (in HTML/JSON) tool results; internal events are dropped |
| Size for one real session | 12.3 MB / 3,295 rows / 33 event types | 0.8–2.5 MB depending on format |
| Shape | Machine-readable, flat, seq-ordered; needs a decoder to read comfortably | Organised by turn → step, with an index, anchors and collapsible sections |
| For agents | No (a browser download) | Yes (`cot_export` / `cot_review` tools, any session) |

Use the built-in export for a **complete archive or forensic copy** — it is the
only thing that carries attachments and byte-exact events. Use this plugin to
**read, review, compare or hand over** the reasoning. It cannot replace a backup:
attachments, request headers and internal events are not in these artifacts.

`derived_from: dsh-session-event-log` in the frontmatter (and the footer of an
HTML artifact) records that distinction.

## Formats

| `format` | File | Shape |
|---|---|---|
| `markdown` (default) | `.md` | Frontmatter + turn index + one section per turn/step, reasoning fenced (the fence adapts when reasoning itself contains backticks) |
| `json` | `.json` | One object: `{schema, session, exported_at, scope, stats, turns[]}` |
| `jsonl` | `.jsonl` | One object per step — grep, `jq`, or feed straight into a pipeline |
| `text` | `.txt` | Minimal plain text |
| `html` | `.html` | Self-contained timeline for browsing: one card per turn, one block per step, collapsible reasoning/answer/tool results, expand-all buttons, anchors, and a light/dark stylesheet driven by `prefers-color-scheme`. No external assets, and every piece of session text is HTML-escaped. |

`html` is the replay view: it is the only format that also carries recorded
**tool results** (success/error, arguments, and up to 4000 characters of each
result, marked when truncated), which is what makes a finished session readable
after the fact without any extra tooling.

## One-click export

Open a session and click the CoT button in the header. One click exports with the
selected format and opens a result panel anchored under the button:

- **format** — an explicit segmented control
  (`Markdown · HTML · JSON · JSONL · Text`). Picking another format re-exports
  immediately and updates the same panel, so the current format is always
  visible instead of hidden behind a menu;
- **numbers** — turns, steps, reasoning characters, reasoning tokens;
- **file** — artifact name and full path; clicking the block copies the path;
- **save to** — the folder the artifact was written to, with **更改** opening the
  host directory picker; the choice is remembered for the next export, and
  **默认** returns to the configured default;
- **下载** — a plain file download with no dialog. The bytes come from an
  `inline=1` response and go through a blob URL, so the shell never navigates to
  the export route (that would open the artifact as a page) and no duplicate
  artifact is written;
- **另存为…** — shown only when the shell implements the save picker; it asks
  where to put the same bytes;
- **复盘包** — writes the CoT plus `REVIEW.md` (rubric, window plan, delegation
  prompt) and offers the prompt on the clipboard;
- **× / Escape / outside click** — dismiss; the button carries a small dot while
  a result is shown, and turns red if the last export failed.

The panel reports a known failure with actionable copy instead of a raw error: a
missing route suggests `/cot`, no recorded reasoning and an out-of-workspace
session each say what happened. Layout follows the host: 28px square trigger,
`--dsw-radius-*` corners, `--dsw-elevation-prominent` elevation, a
`--dsw-focus-ring-color` focus ring, `--dsw-alias-button-info-fill` primary
actions and `--dsw-font-*` typography — no literal colours, so it follows the
active light/dark theme.

### Route contract

The header action talks to one authenticated exact route:

```
GET /api/cot.export
  ?sessionId=<id>            required
  &mode=export|review        review also writes REVIEW.md
  &format=markdown|json|jsonl|text
  &scope=all|surface
  &dir=<absolute folder>     where the artifact is written
  &includeContext=1|0 &includeFailedAttempts=1|0
  &download=1                export, write, then stream the bytes
  &inline=1                  stream the bytes of what was already written
```

`HEAD` answers whether the route exists; unknown sessions return `404`, bad
arguments `400`, and a session without reasoning `409`.

## Slash command

```
/cot                          export this session, configured format
/cot json                     pick the format (md|markdown|json|jsonl|txt|text)
/cot surface                  only what the current model context contains
/cot latest                   the newest other session in this workspace
/cot <id-or-prefix>           any session you can read
/cot review [focus]           export + write REVIEW.md next to it
```

Command output stays on the human plane: it never becomes a model message.

## Tools for other agents

**`cot_export`** — export any session (own, `latest`, exact id or unique id
prefix) and return `path`, byte size and counts. Descendant subagent sessions
can be included as a tree with an `INDEX.md`.

**`cot_review`** — prepare a supervised review package: it writes its own CoT
artifact plus a `REVIEW.md` beside it, containing the review rubric, a window
plan with exact line ranges, and a ready-to-pass delegation prompt. It does
**not** start the reviewer, and it never overwrites an artifact another call
produced (an existing name gets a `-2` suffix).

```
cot_review { "session_id": "latest", "focus": "wasted effort" }
→ pass the returned delegation_prompt to the subagent tool,
  to a teammate, or to another session
```

Because both tools are global, the usual supervision loop needs no new
machinery: export here, hand the prompt to `subagent` / `spawn_teammate` /
another session, and the reviewer reads the file window by window.

The plugin also registers the embedded skill **`cot-review`** (model-invocable),
so a reviewer in any session can load the same rubric with the `skill` tool.

## Configuration

Set these under the plugin's row in your profile's `cordis.patch.yml`; every
field is optional.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `outputDir` | `'cot-exports'` | Absolute, or relative to the target session workspace. |
| `defaultFormat` | `'markdown'` | `markdown` \| `json` \| `jsonl` \| `text`. |
| `defaultScope` | `'all'` | `all` = complete log including compaction-hidden reasoning; `surface` = only the current model context. |
| `includeContext` | `true` | Also record user prompts, answers and tool-call names. |
| `includeFailedAttempts` | `false` | Rebuild the reasoning of failed attempts from their stream. |
| `crossSession` | `'workspace'` | `workspace` = an agent may export another session only when both share the exact `cwd`; `any` = no check. |
| `maxToolPreviewChars` | `600` | Preview length in the `cot_export` result (0 disables). |
| `reviewWindowTurns` | `8` | Turns per review window (0 = one window). |
| `enableRoute` | `true` | Register `GET /api/cot.export` for the header button. |
| `routePath` | `'/api/cot.export'` | Override when another plugin owns that exact path. |
| `enableSkill` | `true` | Register the `cot-review` skill. |

Example override:

```yaml
- id: cot-export
  name: 'dsh-cot-export'
  config:
    outputDir: 'D:/cot-exports'
    defaultScope: 'surface'
```

## Behaviour worth knowing

- **Read-only on sessions.** The plugin reads through `ctx.sessionQuery`; it
  never appends an event, never introduces an event type and never touches a
  stored log. Only the export file is written.
- **Live first.** A live session is read from memory; a persisted-only session
  is read without activating or resuming it. The step that is still streaming
  when you export is not yet committed, so it is not in the artifact.
- **Atomic writes.** The artifact is written to a sibling temporary file and
  renamed, and an existing name gets a `-2` suffix instead of being overwritten.
- **Auth.** The header button reaches the Host through the authenticated exact
  Fetch route (`/api/cot.export`), which only the owner's browser session can
  call. No unauthenticated port is opened.
- **Degradation.** A missing `connection`, `commands` or `skills` service, or a
  colliding route/command name, logs a warning and leaves the rest working.
- **Aggregate bundles.** The patch backs this row off when another enabled entry
  already mounts `dsh-cot-export`, so a "web-ui-all" style bundle and this one
  cannot double-mount.

## Privacy

Reasoning is exported verbatim: it can contain source code, file contents,
paths and secrets the model saw. Artifacts are plaintext files in your
workspace. The plugin makes no network request, sends nothing anywhere, and
uploads nothing.

## Uninstall

Remove the `dsh-cot-export` bundle from the profile (Plugin Manager, or
`plugin_manager remove_bundle`) and delete the `cot-exports` directories you no
longer want. The plugin keeps no other state.

## Install channels in detail

- **GitHub (recommended)**: `dsh plugin --profile <profile> add github:Aliarrrrr/dsh-cot-export`
- **Tarball**: download the `.tgz` from the latest GitHub Release and run
  `dsh plugin --profile <profile> add ./dsh-cot-export-<version>.tgz`
- **Local checkout**: from a clone, `dsh plugin --profile <profile> add .`

A profile whose pnpm install is blocked (for example by a package directory the
current account cannot read) can mount the bundle manually instead — the
fallback path, not the normal one:

```powershell
cmd /c mklink /J "C:\Users\<you>\.dsh\profiles\<profile>\node_modules\dsh-cot-export" "<absolute path to this checkout>"
```

```yaml
# appended to the profile's cordis.patch.yml
- insert:
    - id: cot-export
      name: 'dsh-cot-export'
```

HMR recomposes the profile as soon as that file changes, so the plugin mounts
without a restart; editing files under the linked directory takes effect at the
next recomposition. Undo by deleting the row and the junction, then use the
managed channel.

## Development

```sh
node --test test/cot.test.mjs        # 16 unit tests over the pure core, nothing to install
node selftest/run.mjs <log> ...      # integration harness: real session logs through the real apply()
node selftest/client-test.mjs        # client wiring/state machine (stub renderer, not visual proof)
npm pack --dry-run                   # inspect the published file list
```

The integration harness stubs only `@deepseek-ai/dsh-tools` and
`@deepseek-ai/schemastery`, builds the plugin through its real `apply()`, and
drives both tools, the `/cot` command and every route mode (JSON, HEAD,
download, `mode=review`, 400/404) against decoded `session.v4.jsonl.zstd` logs.
It validates each tool value against that tool's own output schema, so a
schema/value drift fails there instead of at the first live call.

## Community

GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin). Issues and
pull requests are welcome; the install command at the top of this README is the
canonical community entry point.

## License

[MIT](LICENSE) © 2026 Aliarrrrr
