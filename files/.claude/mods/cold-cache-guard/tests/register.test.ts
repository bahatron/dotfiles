import type { EngineInterface, On, PromptOrigin, PromptSubmitInput } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import { formatIdle, formatTokens, readTail, scanTail } from "../hooks/register";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const TRANSCRIPT = "/test/main.jsonl";
const FORCE = "/test/home/.cache/cold-cache-guard/force-once";
const MIB = 1024 * 1024;

type AssistantOptions = {
    tokens?: number;
    idleSeconds?: number;
    timestamp?: string;
    model?: string;
    isSidechain?: boolean;
    ttl?: "1h" | "5m" | "none";
    usage?: Record<string, unknown>;
};

function assistant(options: AssistantOptions = {}) {
    const tokens = options.tokens ?? 400000;
    const writes = options.ttl === "none" ? 0 : 20000;
    return {
        type: "assistant",
        isSidechain: options.isSidechain ?? false,
        timestamp: options.timestamp ?? new Date(NOW - (options.idleSeconds ?? 10800) * 1000).toISOString(),
        message: {
            model: options.model ?? "claude-sonnet-4-6",
            usage: options.usage ?? {
                input_tokens: 2000,
                cache_creation_input_tokens: writes,
                cache_read_input_tokens: tokens - writes - 3000,
                output_tokens: 1000,
                cache_creation: {
                    ephemeral_5m_input_tokens: options.ttl === "5m" ? writes : 0,
                    ephemeral_1h_input_tokens: options.ttl === "5m" ? 0 : writes,
                },
            },
        },
    };
}

function transcript(entries: readonly unknown[]) {
    return entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n";
}

function prompt(overrides: Partial<PromptSubmitInput> = {}): PromptSubmitInput {
    return {
        text: "Please investigate the cache problem.\nKeep this second line.",
        wait: false,
        origin: { kind: "composer" },
        ...overrides,
    };
}

type FixtureOptions = {
    entries?: readonly unknown[];
    force?: boolean;
    missing?: boolean;
    kind?: "file" | "dir" | "other";
    skip?: string;
    rejectCompact?: boolean;
    rejectToast?: boolean;
    rejectRead?: boolean;
    removeExitCode?: number;
    duringCompact?: () => Promise<unknown>;
    dropSubmissions?: number;
    denyRemovalOnce?: boolean;
};

function fixture(on: On, options: FixtureOptions = {}) {
    const files = new Map([[TRANSCRIPT, transcript(options.entries ?? [assistant()])]]);
    const calls: string[] = [];
    const received: PromptSubmitInput[] = [];
    const submitAttempts: PromptSubmitInput[] = [];
    const toasts: string[] = [];
    const removals: string[][] = [];
    const pending: unknown[] = [];
    let forced = options.force ?? false;
    let drops = options.dropSubmissions ?? 0;
    let denyRemoval = options.denyRemovalOnce ?? false;
    const clock = mock.clock(on, { now: NOW });
    mock.env(on, { HOME: "/test/home" });
    on("session.start", ($, e) => ({ cwd: e.cwd }));
    on("classic.SessionStart", () => ({}));
    on("state.set", ($, e, next) => {
        if (e.key === "pendingPrompts") {
            if (denyRemoval && Array.isArray(e.value) && e.value.length === 0) {
                denyRemoval = false;
                calls.push("deny-removal");
                return { deny: "queue removal temporarily unavailable" };
            }
            pending.push(e.value);
        }
        return next(e);
    });
    on("fs.exists", ($, e) => ({ value: e.path === FORCE && forced }));
    on("fs.stat", ($, e) => {
        if (options.missing || !files.has(e.path)) return { deny: "ENOENT transcript" };
        return { value: { kind: options.kind ?? "file", size: files.get(e.path)!.length, mtimeMs: NOW, isLink: false } };
    });
    on("fs.read", ($, e) => {
        calls.push("read");
        if (options.rejectRead) return { deny: "transcript read failed" };
        const text = files.get(e.path) ?? "";
        return { value: e.as === "bytes" ? { base64: btoa(text) } : text };
    });
    on("fs.list", ($, e) => ({ value: [...files.entries()]
        .filter(([path]) => path.startsWith(e.path + "/chunk-"))
        .map(([path, text]) => ({ name: path.slice(e.path.length + 1), kind: "file" as const, size: text.length, mtimeMs: NOW, isLink: false })) }));
    on("process.run", ($, e) => {
        if (e.argv[0] === "/bin/sh") {
            calls.push("stage-tail");
            const path = e.argv[e.argv.length - 3]!;
            const start = Number(e.argv[e.argv.length - 2]);
            const size = Number(e.argv[e.argv.length - 1]);
            const text = files.get(path)!.slice(start, start + size);
            const directory = "/test/staged";
            for (let offset = 0; offset < text.length; offset += MIB) {
                files.set(`${directory}/chunk-${String(offset / MIB).padStart(3, "0")}`, text.slice(offset, offset + MIB));
            }
            return { value: { exitCode: 0, stdout: directory, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
        }
        if (e.argv[1] === "-rf") {
            calls.push("cleanup-tail");
            for (const path of files.keys()) if (path.startsWith(e.argv[2] + "/")) files.delete(path);
            return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
        }
        calls.push("remove-force");
        removals.push([...e.argv]);
        if ((options.removeExitCode ?? 0) === 0) forced = false;
        return { value: {
            exitCode: options.removeExitCode ?? 0,
            stdout: "",
            stderr: "",
            isStdoutTruncated: false,
            isStderrTruncated: false,
        } };
    });
    if (!options.rejectCompact) {
        on("session.compact", async () => {
            calls.push("compact-start");
            if (options.duringCompact && calls.filter((call) => call === "compact-start").length === 1) {
                await options.duringCompact();
            }
            await Promise.resolve();
            calls.push("compact-end");
            return options.skip === undefined ? { messages: [{ role: "user" as const, text: "Conversation summary.", toolUses: [] }] } : { skip: options.skip };
        });
    }
    on("ui.toast", ($, e) => {
        calls.push("toast");
        toasts.push(e.text);
        return options.rejectToast ? { deny: "toast unavailable" } : { value: undefined };
    });
    on("prompt.submit", ($, e) => {
        submitAttempts.push(e);
        if (e.origin.kind === "plugin" && drops > 0) {
            drops -= 1;
            calls.push("drop");
            return { drop: "temporarily unavailable" };
        }
        calls.push("next");
        received.push(e);
        return { text: e.text, context: e.context, origin: e.origin };
    });
    return { files, calls, received, submitAttempts, toasts, removals, pending, clock, forced: () => forced };
}

async function start($: Engine, path = TRANSCRIPT, source: "startup" | "resume" | "clear" = "resume") {
    await $.classic.SessionStart({ source, transcript_path: path });
    if (source !== "clear") await $.session.start({ cwd: "/test", surface: null, isInteractive: false });
}

async function submitAndRun($: Engine, f: ReturnType<typeof fixture>, original = prompt()) {
    const result = await $.prompt.submit(original);
    if (result.drop !== undefined) await f.clock.advance(1000);
    return result;
}

function resubmitted(original: PromptSubmitInput): PromptSubmitInput {
    const { context, command, isMeta, turnId, ...queued } = original;
    return { ...queued, wait: false, origin: { kind: "plugin", name: "cold-cache-guard", asUser: true } };
}

test("cold large session compacts completely before resubmitting the original text", async ($, on) => {
    const f = fixture(on);
    await start($);
    const original = prompt({
        context: ["Context already attached by an earlier hook."],
        wait: true,
    });
    const result = await $.prompt.submit(original);
    expect(result.drop).toMatch(/compacting/i);
    expect(f.received).toEqual([]);
    expect(f.pending[0]).toMatchObject([{ prompt: original }]);
    await f.clock.advance(1000);
    expect(f.calls.filter((call) => call.startsWith("compact") || call === "next")).toEqual([
        "compact-start", "compact-end", "next",
    ]);
    expect(f.received).toEqual([resubmitted(original)]);
    expect(f.toasts).toHaveLength(1);
    expect(f.toasts[0]).toMatch("idle 3h 0m");
    expect(f.toasts[0]).toMatch("~400k tokens");
    expect(f.toasts[0]).toMatch("compacting before your prompt");
});

for (const [name, options] of [
    ["warm large session", { entries: [assistant({ idleSeconds: 600 })] }],
    ["cold small session", { entries: [assistant({ tokens: 50000 })] }],
    ["one token below the size threshold", { entries: [assistant({ tokens: 149999 })] }],
    ["new session", { entries: [] }],
    ["compact boundary after the latest assistant", { entries: [assistant(), { type: "system", subtype: "compact_boundary" }] }],
    ["5-minute cache still warm", { entries: [assistant({ idleSeconds: 120, ttl: "5m" })] }],
    ["exact 1-hour safety threshold", { entries: [assistant({ idleSeconds: 3480 })] }],
    ["exact 5-minute safety threshold", { entries: [assistant({ idleSeconds: 270, ttl: "5m" })] }],
    ["invalid assistant timestamp", { entries: [assistant({ timestamp: "invalid timestamp" })] }],
    ["transcript is a directory", { kind: "dir" }],
] as const) {
    test(`${name} passes the prompt through untouched`, async ($, on) => {
        const f = fixture(on, options);
        await start($);
        const original = prompt();
        await $.prompt.submit(original);
        expect(f.received).toEqual([original]);
        expect(f.calls).not.toContain("compact-start");
        expect(f.toasts).toEqual([]);
    });
}

for (const [name, overrides] of [
    ["slash command", { command: { name: "compact", args: "keep the codeword" } }],
    ["meta prompt", { isMeta: true }],
    ["prompt typed during a turn", { turnId: "turn-running" }],
    ["present empty turn id", { turnId: "" }],
] as const) {
    test(`${name} bypasses the guard and preserves force-once`, async ($, on) => {
        const f = fixture(on, { force: true });
        await start($);
        const original = prompt(overrides);
        await $.prompt.submit(original);
        expect(f.received).toEqual([original]);
        expect(f.calls).toEqual(["next"]);
        expect(f.forced()).toBe(true);
    });
}

test("a warm prompt preserves attachments and existing additional context", async ($, on) => {
    const f = fixture(on, { entries: [assistant({ idleSeconds: 600 })] });
    await start($);
    const original = prompt({
        attachments: [{ type: "document", filename: "notes.pdf", id: "document-1" }],
        context: ["Existing hook context."],
        wait: true,
    });
    await $.prompt.submit(original);
    expect(f.received).toEqual([original]);
    expect(f.calls).not.toContain("compact-start");
});

test("a cold attached prompt passes through with its media and context intact", async ($, on) => {
    const f = fixture(on);
    await start($);
    const original = prompt({
        attachments: [{ type: "image", mediaType: "image/png", filename: "diagram.png", id: "image-1" }],
        context: ["Existing hook context."],
    });
    await $.prompt.submit(original);
    await f.clock.advance(1000);
    expect(f.received).toEqual([original]);
    expect(f.calls).not.toContain("compact-start");
    expect(f.toasts).toHaveLength(1);
    expect(f.toasts[0]).toMatch("sending your prompt with attachments");
});

const otherOrigins: PromptOrigin[] = [
    { kind: "task-notification" }, { kind: "scheduled-trigger" }, { kind: "peer" },
    { kind: "peer-send-message" }, { kind: "projects-relay" }, { kind: "channel", server: "slack" },
    { kind: "coordinator" }, { kind: "observer" }, { kind: "observer-activity" },
    { kind: "auto-continuation" }, { kind: "unclassified" }, { kind: "slack-ping" },
    { kind: "plugin", name: "cold-cache-guard" }, { kind: "plugin", name: "other", asUser: true },
];

for (const origin of otherOrigins) {
    test(`${origin.kind}${origin.kind === "plugin" && origin.asUser ? " asUser" : ""} origin passes straight through`, async ($, on) => {
        const f = fixture(on, { force: true });
        await start($);
        const original = prompt({ origin });
        await $.prompt.submit(original);
        expect(f.received).toEqual([original]);
        expect(f.calls).toEqual(["next"]);
        expect(f.forced()).toBe(true);
    });
}

for (const kind of ["composer", "bridge", "sdk"] as const) {
    test(`${kind} origin runs the cold-cache check`, async ($, on) => {
        const f = fixture(on);
        await start($);
        await submitAndRun($, f, prompt({ origin: { kind } }));
        expect(f.calls).toContain("compact-end");
        expect(f.received).toHaveLength(1);
    });
}

for (const options of [{ skip: "policy vetoed compaction" }, { rejectCompact: true }] as const) {
    test(`${"skip" in options ? "skipped" : "rejected"} compaction still sends the original prompt`, async ($, on) => {
        const f = fixture(on, options);
        await start($);
        const original = prompt();
        await submitAndRun($, f, original);
        expect(f.received).toEqual([resubmitted(original)]);
        expect(f.calls[f.calls.length - 1]).toBe("next");
        expect(f.toasts).toHaveLength(2);
        expect(f.toasts[1]).toMatch("skip" in options ? options.skip! : "session.compact");
        expect(f.toasts[1]).not.toMatch(/\n/);
    });
}

for (const [name, options] of [
    ["missing transcript", { missing: true }],
    ["unreadable transcript", { rejectRead: true }],
    ["invalid token usage", { entries: [assistant({ usage: { input_tokens: -1 } })] }],
] as const) {
    test(`${name} fails open and sends the prompt once`, async ($, on) => {
        const f = fixture(on, options);
        await start($);
        const original = prompt();
        await submitAndRun($, f, original);
        expect(f.received).toEqual([original]);
    });
}

test("a toast error still resubmits the prompt once after compaction", async ($, on) => {
    const f = fixture(on, { rejectToast: true });
    await start($);
    const original = prompt();
    await submitAndRun($, f, original);
    expect(f.received).toEqual([resubmitted(original)]);
    expect(f.calls).toContain("compact-end");
});

test("no transcript path yet fails open", async ($, on) => {
    const f = fixture(on);
    const original = prompt();
    await $.prompt.submit(original);
    expect(f.received).toEqual([original]);
    expect(f.calls).not.toContain("compact-start");
});

test("a cold prompt before the session timer is available fails open", async ($, on) => {
    const f = fixture(on);
    await $.classic.SessionStart({ source: "resume", transcript_path: TRANSCRIPT });
    const original = prompt();
    await $.prompt.submit(original);
    expect(f.received).toEqual([original]);
    expect(f.pending).toEqual([]);
});

test("force-once compacts a warm small existing session only once", async ($, on) => {
    const f = fixture(on, { entries: [assistant({ idleSeconds: 600, tokens: 50000 })], force: true });
    await start($);
    await submitAndRun($, f);
    await submitAndRun($, f, prompt({ text: "A second prompt." }));
    expect(f.forced()).toBe(false);
    expect(f.removals).toEqual([["/bin/rm", FORCE]]);
    expect(f.calls.filter((call) => call === "compact-start")).toHaveLength(1);
    expect(f.toasts[0]).toMatch("idle 10m");
    expect(f.toasts[0]).toMatch("~50k tokens");
    expect(f.received).toHaveLength(2);
});

test("a second prompt submitted during compaction is also sent automatically", async ($, on) => {
    const second = prompt({ text: "A second prompt while compaction runs." });
    const f = fixture(on, { duringCompact: () => $.prompt.submit(second) });
    await start($);
    const first = prompt();
    await submitAndRun($, f, first);
    expect(f.received).toEqual([resubmitted(first), resubmitted(second)]);
});

test("several prompts queued before compaction drain in order", async ($, on) => {
    const f = fixture(on);
    await start($);
    const first = prompt();
    const second = prompt({ text: "The next prompt." });
    await $.prompt.submit(first);
    await $.prompt.submit(second);
    await f.clock.advance(1000);
    expect(f.received).toEqual([resubmitted(first), resubmitted(second)]);
    expect(f.pending[f.pending.length - 1]).toEqual([]);
});

test("a refused resubmission stays queued until one successful retry", async ($, on) => {
    const f = fixture(on, { dropSubmissions: 1 });
    await start($);
    const original = prompt();
    await $.prompt.submit(original);
    await f.clock.advance(0);
    expect(f.received).toEqual([]);
    expect(f.submitAttempts).toHaveLength(1);
    expect(f.pending[f.pending.length - 1]).toMatchObject([{ prompt: original }]);
    expect(f.toasts[f.toasts.length - 1]).toMatch("retrying automatically");
    await f.clock.advance(1000);
    expect(f.received).toEqual([resubmitted(original)]);
    expect(f.submitAttempts).toHaveLength(2);
    expect(f.pending[f.pending.length - 1]).toEqual([]);
    await f.clock.advance(5000);
    expect(f.submitAttempts).toHaveLength(2);
    expect(f.calls.filter((call) => call === "compact-start")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "compact-end")).toHaveLength(1);
});

test("a queue-removal failure retries cleanup without sending or compacting twice", async ($, on) => {
    const f = fixture(on, { denyRemovalOnce: true });
    await start($);
    const original = prompt();
    await $.prompt.submit(original);
    await f.clock.advance(0);
    expect(f.received).toEqual([resubmitted(original)]);
    expect(f.submitAttempts).toHaveLength(1);
    expect(f.calls).toContain("deny-removal");
    expect(f.pending[f.pending.length - 1]).toMatchObject([{ prompt: original }]);
    expect(f.toasts[f.toasts.length - 1]).toMatch("retrying automatically");
    await f.clock.advance(1000);
    expect(f.pending[f.pending.length - 1]).toEqual([]);
    await f.clock.advance(5000);
    expect(f.received).toEqual([resubmitted(original)]);
    expect(f.submitAttempts).toHaveLength(1);
    expect(f.calls.filter((call) => call === "compact-start")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "compact-end")).toHaveLength(1);
});

for (const [name, entries] of [
    ["new", []],
    ["already compacted", [assistant(), { type: "system", subtype: "compact_boundary" }]],
] as const) {
    test(`force-once is consumed without compacting a ${name} session`, async ($, on) => {
        const f = fixture(on, { entries, force: true });
        await start($);
        await $.prompt.submit(prompt());
        expect(f.forced()).toBe(false);
        expect(f.calls).not.toContain("compact-start");
        expect(f.received).toHaveLength(1);
    });
}

test("a failed force-once deletion does not bypass the size and idle checks", async ($, on) => {
    const f = fixture(on, { entries: [assistant({ idleSeconds: 600, tokens: 50000 })], force: true, removeExitCode: 1 });
    await start($);
    await $.prompt.submit(prompt());
    expect(f.forced()).toBe(true);
    expect(f.calls).not.toContain("compact-start");
    expect(f.received).toHaveLength(1);
});

test("force-once never invents a session when the transcript is missing", async ($, on) => {
    const f = fixture(on, { missing: true, force: true });
    await start($);
    const original = prompt();
    await $.prompt.submit(original);
    expect(f.forced()).toBe(false);
    expect(f.calls).not.toContain("compact-start");
    expect(f.received).toEqual([original]);
});

test("SessionStart on clear refreshes the main transcript path", async ($, on) => {
    const f = fixture(on);
    const clearedPath = "/test/cleared.jsonl";
    f.files.set(clearedPath, transcript([]));
    await start($);
    await start($, clearedPath, "clear");
    await $.prompt.submit(prompt());
    expect(f.calls).not.toContain("compact-start");
    expect(f.received).toHaveLength(1);
});

test("clear followed by a real response checks the new transcript", async ($, on) => {
    const f = fixture(on, { entries: [] });
    const clearedPath = "/test/cleared.jsonl";
    f.files.set(clearedPath, transcript([assistant()]));
    await start($, TRANSCRIPT, "startup");
    await start($, clearedPath, "clear");
    await submitAndRun($, f);
    expect(f.calls).toContain("compact-end");
    expect(f.received).toHaveLength(1);
});

test("token threshold includes exactly 150000 tokens", async ($, on) => {
    const f = fixture(on, { entries: [assistant({ tokens: 150000 })] });
    await start($);
    await submitAndRun($, f);
    expect(f.calls).toContain("compact-end");
});

test("a compact boundary before the latest assistant does not suppress compaction", async ($, on) => {
    const f = fixture(on, { entries: [{ type: "system", subtype: "compact_boundary" }, assistant()] });
    await start($);
    await submitAndRun($, f);
    expect(f.calls).toContain("compact-end");
});

for (const [idleSeconds, ttl] of [[3481, "1h"], [271, "5m"], [600, "5m"]] as const) {
    test(`${ttl} cache compacts at idle ${idleSeconds}s`, async ($, on) => {
        const f = fixture(on, { entries: [assistant({ idleSeconds, ttl })] });
        await start($);
        await submitAndRun($, f);
        expect(f.calls).toContain("compact-end");
        expect(f.received).toHaveLength(1);
    });
}

test("a 30 MiB junk line before the latest assistant uses only the 4 MiB tail", async ($, on) => {
    const f = fixture(on, { entries: ["x".repeat(30 * MIB), assistant()] });
    await start($);
    await submitAndRun($, f);
    expect(f.calls.filter((call) => call === "stage-tail")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "cleanup-tail")).toHaveLength(1);
    expect(f.calls).toContain("compact-end");
    expect(f.received).toHaveLength(1);
});

test("the 32 MiB fallback finds an assistant beyond the initial 4 MiB tail", async ($, on) => {
    const f = fixture(on, { entries: [assistant(), { type: "user", text: "x".repeat(5 * MIB) }] });
    await start($);
    await submitAndRun($, f);
    expect(f.calls.filter((call) => call === "stage-tail")).toHaveLength(2);
    expect(f.calls.filter((call) => call === "cleanup-tail")).toHaveLength(2);
    expect(f.calls).toContain("compact-end");
    expect(f.received).toHaveLength(1);
});

test("no assistant in either tail scan passes the prompt through", async ($, on) => {
    const f = fixture(on, { entries: [{ type: "user", text: "x".repeat(5 * MIB) }] });
    await start($);
    const original = prompt();
    await $.prompt.submit(original);
    expect(f.calls.filter((call) => call === "stage-tail")).toHaveLength(2);
    expect(f.calls).not.toContain("compact-start");
    expect(f.received).toEqual([original]);
});

test("qualifying main responses ignore recent sidechains and synthetic messages", () => {
    const result = scanTail(transcript([
        assistant(), assistant({ idleSeconds: 10, tokens: 50000, isSidechain: true }),
        assistant({ idleSeconds: 1, model: "<synthetic>" }),
    ]), NOW);
    expect(result?.tokens).toBe(400000);
    expect(result?.idle).toBe(10800);
});

test("repeated content blocks of one response do not multiply token totals", () => {
    const entry = assistant();
    expect(scanTail(transcript([entry, entry, entry]), NOW)?.tokens).toBe(400000);
});

test("malformed lines and an incomplete final line are skipped", () => {
    const text = transcript(["not json", "{broken}", assistant(), "null", "[]"]) + "{\"type\":\"assistant\",\"timestamp\":";
    expect(scanTail(text, NOW)?.tokens).toBe(400000);
});

test("no qualifying assistant returns null", () => {
    expect(scanTail(transcript([
        { type: "user", message: "hello" }, assistant({ model: "<synthetic>" }),
        { type: "assistant", message: { model: "claude-sonnet-4-6" } },
        { type: "assistant", message: { usage: {} } },
    ]), NOW)).toBe(null);
});

for (const [name, entries, ttl] of [
    ["latest 5-minute write", [assistant({ ttl: "5m" })], 300],
    ["older 5-minute write when latest only reads", [assistant({ ttl: "5m" }), assistant({ ttl: "none", tokens: 200000 })], 300],
    ["newest write", [assistant({ ttl: "5m" }), assistant({ ttl: "1h" }), assistant({ ttl: "none" })], 3600],
    ["no cache writes", [assistant({ ttl: "none" })], 3600],
    ["legacy cache creation count", [assistant({ usage: { cache_creation_input_tokens: 400000 } })], 3600],
] as const) {
    test(`TTL uses ${name}`, () => {
        expect(scanTail(transcript(entries), NOW)?.ttl).toBe(ttl);
    });
}

test("mixed cache writes use the 1-hour TTL", () => {
    const entry = assistant({ usage: {
        cache_creation_input_tokens: 400000,
        cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 399999 },
    } });
    expect(scanTail(transcript([entry]), NOW)?.ttl).toBe(3600);
});

test("TTL uses older writes but tokens and idle use only the latest qualifying response", () => {
    const result = scanTail(transcript([
        assistant({ ttl: "5m", idleSeconds: 1200 }), assistant({ ttl: "none", idleSeconds: 600, tokens: 200000 }),
    ]), NOW);
    expect(result?.ttl).toBe(300);
    expect(result?.tokens).toBe(200000);
    expect(result?.idle).toBe(600);
});

test("an older compact boundary does not stop the search for the latest cache write", () => {
    const result = scanTail(transcript([
        assistant({ ttl: "5m" }), { type: "system", subtype: "compact_boundary" }, assistant({ ttl: "none" }),
    ]), NOW);
    expect(result?.ttl).toBe(300);
    expect(result?.compactAfterLast).toBe(false);
});

test("missing usage fields count as zero", () => {
    expect(scanTail(transcript([assistant({ usage: { cache_read_input_tokens: 400000 } })]), NOW)?.tokens).toBe(400000);
});

for (const usage of [
    { input_tokens: -1 }, { input_tokens: "400000" }, { cache_read_input_tokens: null },
    { cache_creation: null }, { cache_creation: [] },
    { cache_creation: { ephemeral_1h_input_tokens: -1 } },
    { cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: -1 } },
]) {
    test(`invalid usage throws: ${JSON.stringify(usage)}`, () => {
        expect(() => scanTail(transcript([assistant({ usage })]), NOW)).toThrow();
    });
}

test("invalid timestamps and empty model names throw", () => {
    expect(() => scanTail(transcript([assistant({ timestamp: "not a timestamp" })]), NOW)).toThrow();
    expect(() => scanTail(transcript([assistant({ model: "" })]), NOW)).toThrow();
});

test("compact boundaries after the latest assistant are recorded", () => {
    expect(scanTail(transcript([assistant(), { type: "system", subtype: "compact_boundary" }]), NOW)?.compactAfterLast).toBe(true);
    expect(scanTail(transcript([{ type: "system", subtype: "compact_boundary" }, assistant()]), NOW)?.compactAfterLast).toBe(false);
});

test("readTail reads small transcripts directly through the filesystem", async () => {
    const text = transcript([assistant()]);
    const paths: string[] = [];
    const engine = { fs: { read: async (path: string) => { paths.push(path); return text; } } } as unknown as EngineInterface;
    expect(await readTail(engine, TRANSCRIPT, text.length, 4 * MIB)).toBe(text);
    expect(paths).toEqual([TRANSCRIPT]);
});

for (const [seconds, expected] of [
    [-1, "0m"], [59, "0m"], [600, "10m"], [3600, "1h 0m"], [4320, "1h 12m"],
    [47 * 3600 + 12 * 60, "47h 12m"], [48 * 3600, "2d 0h"], [52 * 3600, "2d 4h"],
] as const) {
    test(`formatIdle(${seconds}) is ${expected}`, () => expect(formatIdle(seconds)).toBe(expected));
}

for (const [tokens, expected] of [[0, "~0k"], [150000, "~150k"], [412499, "~412k"], [412500, "~413k"], [1200000, "~1.2M"]] as const) {
    test(`formatTokens(${tokens}) is ${expected}`, () => expect(formatTokens(tokens)).toBe(expected));
}
