---
name: codex-dispatch
description: "Route work to the Codex CLI from the main loop with the quota gate applied: builds, reviews of work Codex did not write, and fan-outs of verifications; a fresh Opus agent reviews Codex's builds, and once Claude's usage reaches 90% Codex takes every role. Checks Codex's live weekly usage and Claude's live 5-hour and weekly usage, runs codex exec in the right sandbox, detects the usage cap, and says when to fall back to Opus agents or stop. Use whenever a task is handed to Codex for any reason other than image generation (art skills) or the designer Drive sync (design-sync), whenever a Codex build needs its review, and before spawning Opus agents for build or verification work. Never wrap Codex in a Claude sub-agent."
---

# Dispatch work to Codex

Simon's laptop-wide rule, 08-09-2026 (also in ~/.claude/CLAUDE.md): Codex is the default builder,
in a fresh session per task, until its weekly usage window reaches the switch threshold;
Opus agents then take every role until the window resets. The reason is to
spend the Codex week before Claude tokens. Measured the same day: one Codex
dispatch from the main loop costs about 1k Claude tokens, four Opus verifiers
cost 542k, and a Claude driver agent around Codex costs 66k to 5.4M per call.

Simon's rule, 03-10-2026: the reviewer is never the model that wrote the work.
A fresh Opus agent reviews Codex's builds; Codex reviews everything else (work
Claude or a person wrote). A fresh session of the same model drops the
builder's context but keeps its training and blind spots; a second model drops
both.

Measured 08-09 to 03-10 from the Codex rollouts and Claude transcripts: 242
Codex builds against 62 Codex reviews, and Opus averaging 352k fresh tokens
(uncached input plus output) per review against 490k per build. Opus reviews
add about 11% to Claude spend where Opus builds would add 59%, and they free
the 25% of Codex spend that reviews took, so the cap comes later.

Simon's rule, 21-10-2026: Claude's allocation outranks Codex's. Once Claude's
5-hour or weekly usage reaches 90%, Codex takes every role until that window
resets: builds, verifications, and reviews, its own builds included (in a fresh
session). Codex then runs past its 95% switch to its hard cap; with both capped,
nothing runs until Simon says so.

## Gate

```bash
node ~/.claude/skills/codex-dispatch/dispatch.mjs quota
```

Asks the Codex app-server for the live weekly figure, the same
`account/rateLimits/read` call the TUI's `/status` and the VS Code extension
make, and prints one JSON line: `route` (`codex`, `opus` or `stop`), `review`
(who reviews a Codex build: `opus`, or `codex` while Claude is at 90%),
`used_percent`, `threshold` (95 unless `--threshold` is given; 100 while Claude
is at 90%), `window_minutes`, `resets_at`, `limit_reached`, `usage_allowed`,
`limit_id`, `plan`, `ms`, and `claude`. The window is `primary` (10080 minutes
on this plan; `secondary` is null).

The same call reads Claude's live usage from Anthropic's OAuth usage endpoint
(`api.anthropic.com/api/oauth/usage`), signed in with Claude Code's stored
login: the macOS keychain item `Claude Code-credentials`, or
`~/.claude/.credentials.json` elsewhere. The token is never printed. `claude`
holds `used_percent` (the higher of the 5-hour and weekly windows), `threshold`
(90 unless `--claude-threshold` is given), `five_hour`, `seven_day`, the higher
window's `resets_at`, and `ms`. Model-scoped weekly buckets (Fable's, today) do
not count: Claude's builders and reviewers run Opus.

| Claude      | Codex under its cap                | Codex capped |
|-------------|------------------------------------|--------------|
| under 90%   | `codex`; Opus reviews Codex builds | `opus`       |
| 90% or more | `codex`; Codex reviews them too    | `stop`       |

Codex counts as capped when `used_percent` is at or above `threshold`, or the
backend reports a limit reached or ordinary usage not allowed. Nothing is cached
and nothing is read from session files: every call spawns a short-lived
`codex app-server` and asks Anthropic in parallel, about half a second. A failed
Codex read (offline, logged out, 20 s timeout) reports `error` and routes to
Codex; the run then fails on its own with the reason in its log. A failed Claude
read reports `claude.error` and routes as if Claude were under 90%.

Simon's rule, 13-09-2026: the gate is this live call and nothing else. Until
then it read the last usage snapshot from the session rollouts, which was only
as fresh as the last real run (a 12-hour-old one said 97% while the extension
showed 100% available), so the skill grew rules about ephemeral runs, snapshot
age, and probe runs to refresh it. All of that is gone: check live when
preparing to dispatch, route on that reading, done.

## Run

```bash
node ~/.claude/skills/codex-dispatch/dispatch.mjs run --label <name> \
  --prompt <scratch>/<name>-prompt.txt --out <scratch>/<name>-out.md \
  --sandbox <read-only|workspace-write|danger-full-access> \
  [--schema <scratch>/<name>-schema.json] [--timeout-s 900] [--cwd <repo>]
```

- **Runs the gate first** unless `--force-codex`; nothing runs on exit 75
  (routed to Opus) or exit 77 (`stop`: Codex capped, Claude at 90%).
- **Exit 76** means Codex hit its cap mid-run (no output, and limit text in the
  log or a fresh gate reading that routes away from Codex); send the same
  prompt where `gate_after.route` points (Opus; on `stop`, ask Simon).
- **Exit 0** with `out_exists: true` is success; the log sits next to the out
  file as `<out>.log`.
- **Prompt and out files live in the session scratchpad**, never in the repo.
- **`--schema`** passes a strict JSON schema (`additionalProperties: false`,
  every property required) so Codex's last message is validated JSON.

## Report

Simon's rule, 17-10-2026: dispatch stays in the main loop, since a wrapper
agent costs 66k to 5.4M Claude tokens per call; two messages keep each run
visible instead.

- **At dispatch:** one line with the label, the task, the sandbox and both gate readings.
- **On return:** exit code and run time, then files changed against the spec.
- **Checks:** each check run, pass or fail, failure output verbatim.
- **Open items:** anything unverified or needing Simon, and the out file's path.

## Sandbox

- **`read-only`**: analysis, finders, verifying claims, anything without tests.
- **`danger-full-access`**: builds and reviews that run tests through Docker or
  touch anything outside the workspace; `workspace-write` denies the Docker
  socket and `--add-dir /run` fails.
- **After any full-access run** compare `git status --porcelain` with the
  pre-run inventory and report files the spec did not cover.

## Fan-out

Launch every item from one shell command, wait, then read the out files:

```bash
for i in 1 2 3; do
  node ~/.claude/skills/codex-dispatch/dispatch.mjs run --label verify-$i \
    --prompt "$S/verify-$i-prompt.txt" --out "$S/verify-$i-out.json" \
    --schema "$S/verify-schema.json" --sandbox read-only &
done
wait
```

Run the command in the background when it can outlast one tool call. Never
spawn a Claude agent to run Codex.

## Review

- **Codex build**: check the gate; `review: "opus"` means one fresh Opus agent
  (the Agent tool, `model: "opus"`), `review: "codex"` a fresh Codex `run`.
- **Anything else** (Claude's or a person's work): `run` the review prompt
  through Codex.
- **Prompt file**: write it as for Codex; the Opus agent's prompt points at it.
- **Sub-reviewers** use the reviewer's model: Opus agents under Opus,
  `codex exec` under Codex.
- **At the cap**: Opus also reviews Opus builds; no second model is left.

## Cadence

Simon's rule, 13-09-2026: a review pass runs only when the work needed a
scratch plan (a plan doc in the repo's working-documents directory) or Simon
asks for one. All other work takes the build path.

- **Build path**: build, then the scope diff (`git status --porcelain` and
  `git diff --stat` against the pre-build inventory, flagging edits the spec
  did not cover), then the dispatcher runs the touched tests and static checks
  once, then the soft checks, then the report.
- **Review path**: build, then the scope diff, which also names the files for
  the review boundary, then one review by the other model (see Review). The
  builder ran the tests and the reviewer runs them again, so the dispatcher
  runs none before the review.
  Soft checks wait for APPROVE (Simon, 13-09-2026): run earlier, they are
  wasted whenever the review requests changes.
- **Soft checks**: a live screenshot or API call, the formatter in check mode
  on the touched files (a formatting-only fix needs no re-review), the repo's
  doc validators when docs changed, and `git worktree list` to remove a
  leftover review worktree.

Simon's rule, 12-09-2026: when a review is due, every build lands before it
starts. When a task splits into several builds, run them (in parallel, or in
order where one depends on another), wait for all of them, run the scope diff
once over the combined tree, then dispatch one review of the whole diff. Never
build, review, build, review: an Opus review pass costs about 350k Claude
tokens and a fresh session's context, and interleaving multiplies that without
adding independence. Fixes take the same shape: the author's model applies
every accepted finding, then the same reviewer model re-reviews the combined
fix diff once.

## Prompt contents

Neither Codex nor a fresh Opus agent has the conversation's context. A build
prompt carries the spec, the acceptance criteria, the files in scope, the test
command, and an order to run the repo's formatter on the files it edits; a
review prompt carries the boundary as object IDs, the original request
verbatim, and a pointer to the review-pass skill. AGENTS.md applies to Codex
automatically; an Opus reviewer's prompt tells it to read AGENTS.md first.

State the edit boundary explicitly: "change only the lines the task needs; never
reformat or rewrite existing lines". Seen 12-09-2026: a rule of "no em-dashes in
any file you edit" made Codex replace every existing em-dash in CLAUDE.md and two
other docs with a colon, 150 lines of noise on a 5-line change. Word style rules
as "in text you write", and diff-check the docs before the review.

## Fallback to Opus

When the gate or a run routes to Opus, do the same work with Opus agents (the
Agent tool, or a Workflow with `model: 'opus'`) from the same prompt file, and
check the gate again on the next dispatch; the window resets weekly.

On `stop` (exit 77), spawn no Opus agent: give Simon both readings and their
reset times, and wait for a go-ahead. Claude's last 10% is Simon's to spend.
