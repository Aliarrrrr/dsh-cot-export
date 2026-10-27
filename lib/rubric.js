/**
 * Review material for dsh-cot-export.
 *
 * The same rubric is served two ways: as an embedded skill (`cot-review`) so
 * another session or agent can load it with the shipped `skill` tool, and as a
 * self-contained `REVIEW.md` written next to an export so a reviewer needs no
 * extra setup. Both are plain text; this module never touches the network.
 */

import { formatIsoWithOffset } from './cot.js'

/** Skill body shared by the embedded skill and the generated REVIEW.md. */
export const RUBRIC = `# CoT review

Use this material to analyse or supervise the chain of thought that
\`dsh-cot-export\` produced for a session. The artifact is a Markdown file whose
YAML frontmatter carries the session facts and whose \`## Index\` table maps every
turn to its line number.

## Read it in windows
1. Read the frontmatter and \`## Index\` first (one \`read\` call with a small
   \`limit\` is enough).
2. Plan windows from the index: a window is a contiguous line range covering one
   or more turns. Never load the whole file at once — a long session is several
   hundred KB of reasoning.
3. Read one window at a time with \`read(path, offset, limit)\`. Keep notes; later
   windows need the notes and the previous turn's conclusion, not the raw text.
4. If a finding depends on a step you have not read, read that window before
   writing the finding.

## What to judge
- **Goal tracking** — does the reasoning answer the user's actual request, or a
  nearby easier question it drifted into?
- **Evidence discipline** — are factual claims checked with a tool before the
  reasoning relies on them, or asserted from memory?
- **Contradiction** — does the reasoning contradict an earlier decision, the tool
  result it just saw, or its own stated plan?
- **Wasted effort** — repeated dead ends, re-reading the same file, re-running a
  failed command unchanged, long detours with no information gain.
- **Verification** — does it verify work before declaring it done, and does it
  distinguish "tested" from "should work"?
- **Instruction drift** — does it ignore a stated constraint (write scope,
  language, plan mode, approval policy, destructive-action rules)?
- **Risk** — irreversible actions taken without verification, secrets copied into
  output, or reasoning that hides a failure.

## Evidence rules
- Quote the exact reasoning text; never paraphrase and present it as a quote.
- Anchor every finding to \`turn N step M\`, the artifact's own headings.
- Never invent a step, tool call or result the artifact does not contain.
- State plainly what you could not see (a step absent from the artifact, no tool
  results exported, a superseded stretch) instead of guessing.
- The artifact marks compaction-hidden steps \`superseded\` and fork-inherited
  steps \`inherited\`; weigh them differently from current steps.

## Severity
\`blocker\` (the work is wrong or unsafe) · \`major\` (materially weakens the
result) · \`minor\` (real but small) · \`note\` (worth knowing). Do not inflate: a
blocker needs evidence that the outcome is wrong.

## Report
- One line of verdict, then findings ordered by severity.
- Each finding: \`[severity] turn N step M: claim — evidence: "quote"\`.
- End with the two or three most valuable changes for a future run.`

/**
 * Group turns into review windows.
 * @param {{turn: number, lineFrom: number, lineTo: number, chars: number}[]} turnLines - Markdown jump table.
 * @param {number} windowTurns - turns per window; `0` or less means one window.
 * @returns {{turn_from: number, turn_to: number, line_from: number, line_to: number, chars: number}[]} windows.
 */
export function planWindows(turnLines, windowTurns) {
  const entries = Array.isArray(turnLines) ? turnLines : []
  if (entries.length === 0) return []
  const size = Number.isFinite(windowTurns) && windowTurns > 0 ? Math.trunc(windowTurns) : entries.length
  const windows = []
  for (let start = 0; start < entries.length; start += size) {
    const slice = entries.slice(start, start + size)
    const first = slice[0]
    const last = slice[slice.length - 1]
    windows.push({
      turn_from: first.turn,
      turn_to: last.turn,
      line_from: first.lineFrom,
      line_to: last.lineTo,
      chars: slice.reduce((total, entry) => total + entry.chars, 0),
    })
  }
  return windows
}

/**
 * One-line-per-window table used by both the artifact and the review document.
 * @param {{turn_from: number, turn_to: number, line_from: number, line_to: number, chars: number}[]} windows - review windows.
 * @returns {string[]} table lines.
 */
function windowTable(windows) {
  const lines = ['| Window | Turns | Lines | CoT chars |', '|---|---|---|---|']
  windows.forEach((window, index) => {
    const turns = window.turn_from === window.turn_to ? `${window.turn_from}` : `${window.turn_from}-${window.turn_to}`
    lines.push(`| ${index + 1} | ${turns} | ${window.line_from}-${window.line_to} | ${window.chars} |`)
  })
  return lines
}

/**
 * Build the self-contained review document written beside an export.
 * @param {object} input - review inputs.
 * @param {object} input.model - extracted chain-of-thought model.
 * @param {string} input.cotPath - absolute path of the CoT artifact.
 * @param {string} input.reviewName - file name of this review document.
 * @param {string} [input.focus] - what the requester wants emphasised.
 * @param {object[]} input.windows - planned review windows.
 * @param {number} input.generatedAt - epoch milliseconds.
 * @returns {string} the REVIEW.md body.
 */
export function buildReviewDoc(input) {
  const { model, cotPath, reviewName, focus, windows, generatedAt } = input
  const title = model.session.title ?? model.session.id
  const lines = [
    `# CoT review plan — ${title}`,
    '',
    `- Session \`${model.session.id}\``,
    `- Chain of thought: \`${cotPath}\``,
    `- Workspace \`${model.session.cwd ?? '(none)'}\``,
    `- Turns ${model.stats.turns} · steps ${model.stats.steps} · reasoning chars ${model.stats.reasoning_chars}` +
      (model.stats.reasoning_tokens === undefined ? '' : ` · reasoning tokens ${model.stats.reasoning_tokens}`),
    `- Scope \`${model.scope}\`` +
      (model.stats.superseded_steps === 0
        ? ''
        : ` · ${model.stats.superseded_steps} steps hidden from the current context by compaction`),
    `- Review document \`${reviewName}\``,
    `- Generated ${formatIsoWithOffset(generatedAt)}`,
    '',
  ]
  if (typeof focus === 'string' && focus.trim() !== '') lines.push(`## Requested focus`, '', focus.trim(), '')
  lines.push('## Windows', '')
  if (windows.length === 0) {
    lines.push('The artifact has no turn index to slice; read it once with the `read` tool.', '')
  } else {
    lines.push(...windowTable(windows), '')
    lines.push(
      'Read one window at a time: `read` the CoT artifact with `offset = line_from - 1` and',
      '`limit = line_to - line_from + 1`, then record findings before moving on.',
      '',
    )
  }
  lines.push('## Rubric', '', RUBRIC, '')
  return `${lines.join('\n')}\n`
}

/**
 * Task text a caller can hand to another agent or session as-is.
 * @param {object} input - prompt inputs.
 * @param {string} input.cotPath - absolute CoT artifact path.
 * @param {string} input.reviewPath - absolute review document path.
 * @param {string} [input.focus] - requested focus.
 * @param {object[]} input.windows - planned windows.
 * @param {string} input.sessionId - reviewed session id.
 * @returns {string} the delegation prompt.
 */
export function buildDelegationPrompt(input) {
  const { cotPath, reviewPath, focus, windows, sessionId } = input
  const windowCount = Array.isArray(windows) ? windows.length : 0
  const focusText = typeof focus === 'string' && focus.trim() !== '' ? ` Focus on: ${focus.trim()}.` : ''
  return (
    `Review the model chain of thought recorded for DSH session ${sessionId}. ` +
    `The CoT artifact is ${cotPath}; the rubric, the line index and the window plan are in ${reviewPath}. ` +
    `Read the rubric first, then read the artifact window by window with the read tool ` +
    (windowCount > 1 ? `(${windowCount} windows, each with its own line range)` : '(one window)') +
    ` — do not load the whole file at once. Quote exact reasoning text and anchor every finding to "turn N step M". ` +
    `Return findings ordered by severity (blocker, major, minor, note), then the two or three most valuable changes. ` +
    `Do not modify any file.${focusText}`
  )
}
