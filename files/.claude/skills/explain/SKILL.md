---
name: explain
description: >
  Explain a system, plan, or change in Simon's preferred shape: Problem →
  Consequence → Solution bullets → ASCII maps (before/after) → one-line
  punchline. Use whenever Simon asks to explain, understand, or "give me an
  explanation of" something: especially plans, architectures, incidents, and
  trade-offs. In chat use ASCII diagrams; in committed docs use Mermaid.
---

# Explain: problem / consequence / solution / maps

The shape that works, validated on the BullMQ export-jobs plan (2026-08-11).
Every section earns its place; skip none, pad none.

**Above all: simple, concise language following Miller's law.** Never more than
five parallel items at any level: five bullets, five boxes in a map, five
sections. If a sixth appears, merge or cut; if a sentence needs a comma-chain
to survive, split it. Short words beat long ones, and one idea per sentence.
The reader should never have to hold more than a handful of things in their
head at once. That constraint outranks completeness.

## The structure, in order

1. **The problem.** One short paragraph: what is wrong *today*, in concrete terms.
   Follow immediately with an ASCII map of the current state; the map shows the
   flaw, the prose names it. Annotate the failure path ON the map (arrows to the
   bad outcome, not a footnote).
2. **The consequence.** One paragraph: what the problem costs, with real numbers
   and incidents where they exist ("the e2e's one collision cost us a product
   until manual replay"). This is the "why care". Never skip it.
3. **The solution.** Bullet points only, four or five of them. Each bullet is one design
   move: **bold key term first**, then the mechanism, then why it is safe or
   what it fixes. Attribute decisions the reader made ("your call").
4. **The target-state ASCII map.** Same visual vocabulary as the first map so
   before/after diff by eye. Annotate where the old failure now goes (the retry
   path, the visible ledger).
5. **The punchline.** One line, pattern: *"X turns [old bad outcome] into
   [new good outcome]: [what stays the same]."* Naming what does NOT change is
   half the reassurance.

## Rules

- **Two maps, not one.** Before and after. The explanation IS the diff.
- **ASCII in chat, Mermaid in committed docs.** Never paste Mermaid into chat.
- **Reuse the reader's vocabulary** and map each of their terms to the concrete
  thing that delivers it (their "job" → the BullMQ job id that implements it).
- **Failure paths live on the map.** A diagram showing only the happy path
  explains nothing worth explaining.
- Max 5 top-level chunks, short paragraphs, bold for skimming (house style).
- No em-dashes in anything drafted for sharing onward.

## Map conventions

- Boxes for components, `──▶` for flow, `▼` for consequence drops.
- Label edges with the *meaning* of the hop ("offsets now mean 'durably
  enqueued'"), not just the transport.
- Mark the changed/new pieces distinctly (a labelled queue box, a NEW tag).
- Keep each map under ~20 lines; two small maps beat one mural.

## Compressed example (from the validating case)

> **Problem:** consume, DB join, vendor POST and offset commit are welded into
> one Kafka callback.
> `[map: POST throws → buffer already emptied → batch DROPPED, no retry, no trace]`
> **Consequence:** one flaky HTTP response loses 50 messages silently; no
> pacing, no per-product answer to "what failed?".
> **Solution:** • **one job per (product, collection)**, id is the dedup •
> **payload = signal, worker joins DB fresh** • **concurrency 10 + limiter** •
> **retry ladder, 4xx fatal** • **offsets commit after enqueue** • **the seam
> doesn't move**.
> `[map: queue in the middle, retry loop drawn, Bull Board as the ledger]`
> **Punchline:** the queue turns "one bad POST loses a Kafka batch" into "one
> bad POST is a retrying job you can see": same seam, same adapters, one new hop.
