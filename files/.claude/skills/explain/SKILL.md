---
name: explain
description: >
  Explain plans, architectures and incidents in Simon's preferred shape: a
  layman premise → at most five key points shaped to the subject → ASCII maps
  → one-line punchline. The same frame fits concepts, processes and trade-offs.
  Use when Simon asks "explain", "help me understand", "what's the end result"
  or "give me an explanation of".
  In chat use ASCII diagrams; in committed docs use Mermaid.
---

# Explain: premise, five points, map, punchline

## The frame

Simon's rule, 17-10-2026: the fixed Problem → Consequence → Solution order only fits changes, since not everything has a problem.
The frame stays; the middle follows the subject.

1. **Premise**: one layman line on what it aims to achieve, the "answer first" line.
2. **Key points**: at most five top-level points in the subject's shape; lists inside each stop at five.
3. **Map**: one by default; before and after for changes; skip only when nothing has a shape to draw.
4. **Punchline**: one line to keep; add something the premise did not say, never restate it.

**Miller's law**: simple, concise language and at most five parallel items at any level outrank completeness.
A sixth item means merge or cut; a comma-chain sentence means split.

- **Reader's vocabulary**: reuse their terms; map each to the concrete thing that delivers it (their "job" → the BullMQ job id that implements it).
- **No em-dashes**: use commas, colons, periods or parentheses in anything drafted for sharing onward.

## The premise

- **Purpose, not mechanism**: what it achieves and for whom.
- **Layman test**: someone outside the field gets it on first read.
- **No jargon**: terms the reader may not know wait for the key points.
- **Analogies welcome**: one short example, such as "a waiting line for work".
- **One line**: if it needs a comma-chain, it is not condensed yet.

## Pick the shape

Ask what the reader is missing, then pick the row that fills it.

| Subject | Key points | Map | Punchline |
|---|---|---|---|
| **Change or fix** (plan, incident, bug, migration, "what's the end result") | Problem, consequence, solution moves | Before and after | "X turns [old bad outcome] into [new good outcome]: [what stays the same]." |
| **Concept** (a term, pattern, idea) | What it does, how it works, where it shows up | The mechanism | The line to keep when the details fade |
| **System** (architecture, service, codebase) | The parts, what each owns, how they connect | Structure with failure paths | Where it holds or breaks |
| **Process** (workflow, lifecycle, "what happens when") | The steps in order, what fails at each | The flow | The step everything hinges on |
| **Choice** (trade-off, X vs Y, decision) | Options with cost, best for, what you give up; recommend one, listed first, with the reason | Side by side | What is really being chosen, stakes included |

- **Mixed subjects**: lead with the dominant row, borrow one piece, stay at five points.
- **Skip empty slots**: no problem means no problem section; never invent one.
- **Real numbers**: use real numbers and incidents for consequences where they exist; vague but honest beats invented.
- **Solution moves**: one design move each, bold key term first, then mechanism, then why it is safe or what it fixes; attribute the reader's decisions ("your call").

## Maps

- **Mechanism**: the map shows it; the prose names it.
- **Failure paths**: draw arrows to bad outcomes on the map, never in a footnote. A happy-path-only diagram explains nothing worth explaining.
- **Before and after**: use one visual vocabulary so maps diff by eye. Show where the old failure now goes: the retry path, the visible ledger.
- **Changes**: tag changed or new pieces `NEW`; label edges with the hop's meaning, not just transport.
- **Conventions**: boxes for components, `──▶` for flow, `▼` for consequence drops. Keep each map under ~20 lines; two small maps beat one mural.

ASCII in chat, Mermaid in committed docs; never paste Mermaid into chat.

## Examples

**Change or fix**: BullMQ export-jobs, validated 2026-08-11.

> **Premise:** put a to-do list between reading messages and sending them, so a failed send is retried instead of lost.
> **Problem:** consume, DB join, vendor POST and offset commit are welded into
> one Kafka callback.
> `[map: POST throws → buffer already emptied → batch DROPPED, no retry, no trace]`
> **Consequence:** one flaky HTTP response loses 50 messages silently; no
> pacing, no per-product answer to "what failed?".
> **Solution:** • **one job per (product, collection)**, id is the dedup •
> **payload = signal, worker joins DB fresh** • **concurrency 10 + limiter** •
> **retry ladder, 4xx fatal** • **offsets commit after enqueue**.
> `[map: queue in the middle, retry loop drawn, Bull Board as the ledger]`
> **Punchline:** the queue turns "one bad POST loses a Kafka batch" into "one
> bad POST is a retrying job you can see": same seam, same adapters, one new hop.

**Concept**: idempotency.

> **Premise:** doing it twice ends where doing it once did, so retrying is safe.
> **Key points:** • **same end state**, a second call changes nothing •
> **keyed by an id**, the server remembers requests it already applied and returns the stored result •
> **where it shows up**: payment idempotency keys, job ids as dedup in queues, HTTP PUT (idempotent) against POST (not).
> `[map: request → seen this id? → yes: return the stored result / no: apply, store the result]`
> **Punchline:** idempotency turns "did it go through?" into a question you never need answered: send it again.
