---
name: codex-dispatch
description: "Route work to the Codex CLI from the main loop with the weekly quota gate applied: builds, reviews, and fan-outs of verifications. Reads the gate, runs codex exec non-ephemerally in the right sandbox, detects the usage cap, and says when to fall back to Opus agents. Use whenever a task is handed to Codex for any reason other than image generation (art skills) or the designer Drive sync (design-sync), and before spawning Opus agents for build or verification work. Never wrap Codex in a Claude sub-agent."
---

# Dispatch work to Codex

Simon's laptop-wide rule, 08-09-2026 (also in ~/.claude/CLAUDE.md): Codex is the default builder and the reviewer, each
in a fresh session, until its weekly usage window reaches the switch threshold;
Opus agents then take both roles until the window resets. The reason is to
spend the Codex week before Claude tokens. Measured the same day: one Codex
dispatch from the main loop costs about 1k Claude tokens, four Opus verifiers
cost 542k, and a Claude driver agent around Codex costs 66k to 5.4M per call.

## Gate

```bash
node ~/.claude/skills/codex-dispatch/dispatch.mjs quota
```

Prints one JSON line: `route` (`codex` or `opus`), `used_percent`, `threshold`
(95 unless `--threshold` is given), `resets_at`, `limit_reached`, and the
rollout the reading came from. The reading is the last `rate_limits` snapshot
in the newest Codex session rollout under `~/.codex/sessions/`; the window is
`primary` (10080 minutes on this plan; `secondary` is null). A reset time in
the past routes to Codex again. `--ephemeral` runs write no rollout, so never
use it for dispatched work.

## Run

```bash
node ~/.claude/skills/codex-dispatch/dispatch.mjs run --label <name> \
  --prompt <scratch>/<name>-prompt.txt --out <scratch>/<name>-out.md \
  --sandbox <read-only|workspace-write|danger-full-access> \
  [--schema <scratch>/<name>-schema.json] [--timeout-s 900] [--cwd <repo>]
```

- **Runs the gate first** unless `--force-codex`; exit 75 means it routed to
  Opus and nothing ran.
- **Exit 76** means Codex hit its cap mid-run (no output, and limit text in the
  log or `rate_limit_reached_type` set); route the same prompt to Opus.
- **Exit 0** with `out_exists: true` is success; the log sits next to the out
  file as `<out>.log`.
- **Prompt and out files live in the session scratchpad**, never in the repo.
- **`--schema`** passes a strict JSON schema (`additionalProperties: false`,
  every property required) so Codex's last message is validated JSON.

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

## Prompt contents

Codex has none of the conversation's context. A build prompt carries the spec,
the acceptance criteria, the files in scope, and the test command; a review
prompt carries the boundary as object IDs, the original request verbatim, and a
pointer to the review-pass skill. AGENTS.md applies to Codex automatically.

## Fallback to Opus

When the gate or a run routes to Opus, do the same work with Opus agents (the
Agent tool, or a Workflow with `model: 'opus'`) from the same prompt file, and
check the gate again on the next dispatch; the window resets weekly.
