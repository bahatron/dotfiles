import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./cold-cache-guard.mjs", import.meta.url));
const RESTORE_PREFIX = "Cold-cache guard: the user typed \"go\" to send the prompt the guard paused earlier. Treat the text below as the user's message and respond to it.\n\n";

function assistant(options = {}) {
    let tokens = options.tokens ?? 400000;
    let writes = options.ttl === "none" ? 0 : 20000;
    return {
        type: "assistant",
        isSidechain: options.isSidechain ?? false,
        timestamp: options.timestamp ?? new Date(Date.now() - (options.idleSeconds ?? 10800) * 1000).toISOString(),
        message: {
            id: options.id ?? "msg_test",
            model: options.model ?? "claude-fable-5-1",
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

function fixture(t, entries = [assistant()]) {
    let root = mkdtempSync(join(tmpdir(), "cold-cache-guard-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let state = join(root, "state");
    let transcript = join(root, "transcript.jsonl");
    let cwd = join(root, "project");
    mkdirSync(state);
    writeFileSync(transcript, entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n");
    let saved = join(state, `saved-${createHash("sha1").update(cwd).digest("hex").slice(0, 16)}.json`);
    return { root, state, transcript, cwd, saved };
}

function run(f, options = {}) {
    let env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COLD_CACHE_GUARD")));
    let input = options.raw ?? JSON.stringify({
        transcript_path: f.transcript,
        cwd: f.cwd,
        session_id: "session-test",
        user_input: "Please investigate the cache problem.\nKeep this second line.",
        ...options.input,
    });
    let result = spawnSync(process.execPath, [HOOK], {
        input,
        encoding: "utf8",
        timeout: 5000,
        env: { ...env, COLD_CACHE_GUARD_STATE_DIR: f.state, ...options.env },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    return result.stdout;
}

function allow(f, options) {
    assert.equal(run(f, options), "");
}

function block(f, options) {
    let output = JSON.parse(run(f, options));
    assert.deepEqual(Object.keys(output).sort(), ["decision", "reason"]);
    assert.equal(output.decision, "block");
    assert.equal(typeof output.reason, "string");
    assert.match(output.reason, /^[\x20-\x7e\n]*$/);
    for (let line of output.reason.split("\n")) {
        assert.ok(line.length < 64, `Notice line is too long: ${line}`);
    }
    return output.reason;
}

function save(f, overrides = {}) {
    let saved = {
        prompt: "The original prompt.\nWith a second line.",
        savedAt: Date.now(),
        sessionId: "previous-session",
        cwd: f.cwd,
        ...overrides,
    };
    writeFileSync(f.saved, JSON.stringify(saved), { mode: 0o600 });
    return saved;
}

test("warm big session allows the prompt", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 600 })]);
    allow(f);
    assert.deepEqual(readdirSync(f.state), []);
});

test("cold small session allows the prompt", (t) => {
    let f = fixture(t, [assistant({ tokens: 50000 })]);
    allow(f);
    assert.deepEqual(readdirSync(f.state), []);
});

test("cold big session blocks and privately saves the entire prompt", (t) => {
    let f = fixture(t);
    let before = Date.now();
    let reason = block(f);
    for (let fragment of ["3h", "~400k", "/compact", "/clear", "go", "~$8.0", "~$4.0", "~$0.9", "30 min"]) {
        assert.ok(reason.includes(fragment), `Missing notice fragment: ${fragment}`);
    }
    let saved = JSON.parse(readFileSync(f.saved, "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["cwd", "prompt", "savedAt", "sessionId"]);
    assert.equal(saved.prompt, "Please investigate the cache problem.\nKeep this second line.");
    assert.equal(saved.cwd, f.cwd);
    assert.equal(saved.sessionId, "session-test");
    assert.ok(saved.savedAt >= before && saved.savedAt <= Date.now());
    assert.equal(statSync(f.saved).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.state), [f.saved.split("/").at(-1)]);
});

test("go restores a blocked prompt without another cold check", (t) => {
    let f = fixture(t);
    block(f);
    let saved = JSON.parse(readFileSync(f.saved, "utf8"));
    assert.deepEqual(JSON.parse(run(f, { input: { user_input: "go" } })), {
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: RESTORE_PREFIX + saved.prompt,
        },
    });
    assert.equal(existsSync(f.saved), false);
    assert.deepEqual(readdirSync(f.state), []);
});

for (let prompt of ["  GO. \n", "Go!"]) {
    test(`${JSON.stringify(prompt)} restores across session ids using cwd`, (t) => {
        let f = fixture(t);
        let saved = save(f);
        let output = JSON.parse(run(f, { input: { user_input: prompt, session_id: "new-session" } }));
        assert.equal(output.hookSpecificOutput.additionalContext, RESTORE_PREFIX + saved.prompt);
        assert.equal(existsSync(f.saved), false);
    });
}

test("go without a saved prompt is an ordinary warm-session prompt", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 600 })]);
    allow(f, { input: { user_input: "go" } });
    assert.deepEqual(readdirSync(f.state), []);
});

test("go deletes a saved prompt older than 30 minutes", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 600 })]);
    save(f, { savedAt: Date.now() - 31 * 60000 });
    allow(f, { input: { user_input: "go" } });
    assert.equal(existsSync(f.saved), false);
});

test("a compact boundary after the last assistant allows the prompt", (t) => {
    let f = fixture(t, [assistant(), { type: "system", subtype: "compact_boundary" }]);
    allow(f);
    assert.deepEqual(readdirSync(f.state), []);
});

test("a compact boundary before the last assistant does not suppress a block", (t) => {
    let f = fixture(t, [{ type: "system", subtype: "compact_boundary" }, assistant()]);
    block(f);
});

test("5-minute writes block after 10 minutes with 1.25x write pricing", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 600, ttl: "5m" })]);
    let reason = block(f);
    assert.match(reason, /10m/);
    assert.match(reason, /~\$5\.0/);
    assert.match(reason, /~\$4\.0/);
    assert.match(reason, /~\$0\.6/);
});

test("5-minute writes allow after 2 minutes", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 120, ttl: "5m" })]);
    allow(f);
});

test("recent sidechain entries do not hide a cold main conversation", (t) => {
    let f = fixture(t, [assistant(), assistant({ idleSeconds: 10, tokens: 50000, isSidechain: true })]);
    block(f);
});

test("repeated content blocks of one response do not multiply token totals", (t) => {
    let entry = assistant();
    let f = fixture(t, [entry, entry, entry]);
    let reason = block(f);
    assert.match(reason, /~400k/);
    assert.doesNotMatch(reason, /~1\.2M/);
    assert.match(reason, /~\$8\.0/);
});

test("malformed lines and an incomplete last line are skipped", (t) => {
    let f = fixture(t, ["not json", "{broken}", assistant(), "null", "[]"]);
    writeFileSync(f.transcript, readFileSync(f.transcript, "utf8") + "{\"type\":\"assistant\",\"timestamp\":");
    block(f);
});

test("missing transcript fails open", (t) => {
    let f = fixture(t);
    allow(f, { input: { transcript_path: join(f.root, "missing.jsonl") } });
    assert.deepEqual(readdirSync(f.state), []);
});

test("unreadable transcript shape fails open", (t) => {
    let f = fixture(t);
    allow(f, { input: { transcript_path: f.root } });
});

for (let raw of ["", "not json", "null", "[]", "{}", "42"]) {
    test(`invalid stdin shape ${JSON.stringify(raw)} fails open`, (t) => {
        let f = fixture(t);
        allow(f, { raw });
        assert.deepEqual(readdirSync(f.state), []);
    });
}

for (let value of ["off", "0"]) {
    test(`COLD_CACHE_GUARD=${value} disables the guard`, (t) => {
        let f = fixture(t);
        allow(f, { env: { COLD_CACHE_GUARD: value } });
        assert.deepEqual(readdirSync(f.state), []);
    });
}

test("force-once blocks a warm session, uses real numbers, and consumes the flag", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 600, tokens: 50000 })]);
    let flag = join(f.state, "force-once");
    writeFileSync(flag, "");
    let reason = block(f);
    assert.match(reason, /10m/);
    assert.match(reason, /~50k/);
    assert.match(reason, /~\$1\.0/);
    assert.equal(existsSync(flag), false);
    allow(f);
});

test("force-once uses defaults when the transcript is missing", (t) => {
    let f = fixture(t);
    let flag = join(f.state, "force-once");
    writeFileSync(flag, "");
    let reason = block(f, { input: { transcript_path: join(f.root, "missing.jsonl") } });
    assert.match(reason, /3h/);
    assert.match(reason, /~400k/);
    assert.doesNotMatch(reason, /\$/);
    assert.equal(existsSync(flag), false);
    assert.equal(existsSync(f.saved), true);
});

for (let agentId of ["agent-test", "", null]) {
    test(`present agent_id ${JSON.stringify(agentId)} bypasses the guard`, (t) => {
        let f = fixture(t);
        allow(f, { input: { agent_id: agentId } });
        assert.deepEqual(readdirSync(f.state), []);
    });
}

test("unknown model still blocks without dollar figures", (t) => {
    let f = fixture(t, [assistant({ model: "claude-sonnet-5-5" })]);
    let reason = block(f);
    assert.doesNotMatch(reason, /\$|at API prices/);
    assert.match(reason, /Sending now rewrites all of it\./);
    for (let fragment of ["/compact", "/clear", "go", "30 min"]) {
        assert.ok(reason.includes(fragment));
    }
});

test("state directory beneath a regular file fails open", (t) => {
    let f = fixture(t);
    let file = join(f.root, "regular-file");
    writeFileSync(file, "not a directory");
    allow(f, { env: { COLD_CACHE_GUARD_STATE_DIR: join(file, "state") } });
    assert.equal(readFileSync(file, "utf8"), "not a directory");
    assert.deepEqual(readdirSync(f.state), []);
});

test("a 30 MiB junk line before the last assistant is handled within 1.5 seconds", (t) => {
    let f = fixture(t, ["x".repeat(30 * 1024 * 1024), assistant()]);
    let started = performance.now();
    block(f);
    assert.ok(performance.now() - started < 1500, "Tail scan exceeded 1.5 seconds");
});

test("the 32 MiB fallback finds an assistant beyond the initial 4 MiB tail", (t) => {
    let f = fixture(t, [assistant(), JSON.stringify({ type: "user", text: "x".repeat(5 * 1024 * 1024) })]);
    block(f);
});

test("no qualifying assistant anywhere in the scan window allows the prompt", (t) => {
    let f = fixture(t, [
        { type: "user", message: "hello" },
        assistant({ model: "<synthetic>" }),
        { type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-fable-5-1" } },
    ]);
    allow(f);
    assert.deepEqual(readdirSync(f.state), []);
});

test("TTL comes from older cache writes when the latest response only reads", (t) => {
    let f = fixture(t, [
        assistant({ idleSeconds: 1200, ttl: "5m" }),
        assistant({ idleSeconds: 600, ttl: "none" }),
    ]);
    assert.match(block(f), /~\$5\.0/);
});

test("the newest cache write determines TTL", (t) => {
    let f = fixture(t, [
        assistant({ idleSeconds: 1200, ttl: "5m" }),
        assistant({ idleSeconds: 900, ttl: "1h" }),
        assistant({ idleSeconds: 600, ttl: "none" }),
    ]);
    allow(f);
});

test("no cache writes in the window defaults to a 1-hour TTL", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 600, ttl: "none" })]);
    allow(f);
});

test("mixed cache writes use the 1-hour TTL", (t) => {
    let entry = assistant({ idleSeconds: 600 });
    entry.message.usage.cache_creation.ephemeral_5m_input_tokens = 1;
    let f = fixture(t, [entry]);
    allow(f);
});

test("the 1-hour TTL includes a 120-second safety margin", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 3500 })]);
    assert.match(block(f), /58m/);
});

test("the 5-minute TTL includes a 30-second safety margin", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 280, ttl: "5m" })]);
    block(f);
});

test("MIN_TOKENS can lower the threshold", (t) => {
    let f = fixture(t, [assistant({ tokens: 50000 })]);
    block(f, { env: { COLD_CACHE_GUARD_MIN_TOKENS: "50000" } });
});

test("MIN_TOKENS can raise the threshold", (t) => {
    let f = fixture(t);
    allow(f, { env: { COLD_CACHE_GUARD_MIN_TOKENS: "500000" } });
});

test("SAVE_MINUTES changes both the notice and restore lifetime", (t) => {
    let f = fixture(t);
    let env = { COLD_CACHE_GUARD_SAVE_MINUTES: "60" };
    assert.match(block(f, { env }), /60 min/);
    let saved = save(f, { savedAt: Date.now() - 45 * 60000 });
    let output = JSON.parse(run(f, { input: { user_input: "go" }, env }));
    assert.equal(output.hookSpecificOutput.additionalContext, RESTORE_PREFIX + saved.prompt);
    assert.equal(existsSync(f.saved), false);
});

test("expired saved prompts are cleaned up on an ordinary warm run", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 600 })]);
    let old = join(f.state, "saved-old.json");
    let unrelated = join(f.state, "notes.json");
    let stale = JSON.stringify({ prompt: "old", savedAt: Date.now() - 25 * 3600000, sessionId: "old", cwd: "other" });
    writeFileSync(old, stale);
    writeFileSync(unrelated, stale);
    save(f);
    allow(f);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(f.saved), true);
    assert.equal(existsSync(unrelated), true);
});

test("prompt is used when user_input is absent", (t) => {
    let f = fixture(t);
    block(f, { input: { user_input: undefined, prompt: "Fallback prompt" } });
    assert.equal(JSON.parse(readFileSync(f.saved, "utf8")).prompt, "Fallback prompt");
});

test("user_input takes precedence over prompt, including an empty string", (t) => {
    let f = fixture(t);
    block(f, { input: { user_input: "", prompt: "Do not save this fallback" } });
    assert.equal(JSON.parse(readFileSync(f.saved, "utf8")).prompt, "");
});

for (let input of [{ user_input: null }, { user_input: 42 }, { cwd: null }, { transcript_path: [] }]) {
    test(`unexpected input fields fail open: ${JSON.stringify(input)}`, (t) => {
        let f = fixture(t);
        allow(f, { input });
        assert.deepEqual(readdirSync(f.state), []);
    });
}

test("invalid assistant timestamp fails open", (t) => {
    let f = fixture(t, [assistant({ timestamp: "invalid timestamp" })]);
    allow(f);
});

test("missing usage fields count as zero", (t) => {
    let f = fixture(t, [assistant({ usage: { cache_read_input_tokens: 400000 } })]);
    assert.match(block(f), /~400k/);
});

test("model suffixes are stripped before pricing", (t) => {
    let f = fixture(t, [assistant({ model: "claude-fable-5-1-20260928[1m]" })]);
    assert.match(block(f), /~\$8\.0/);
});

for (let [model, cost] of [
    ["claude-fable-5", "~$8.0"],
    ["claude-mythos-5", "~$8.0"],
    ["claude-mythos-5-1", "~$8.0"],
    ["claude-opus-5-5", "~$3.2"],
    ["claude-opus-5", "~$4.0"],
    ["claude-opus-4-8", "~$4.0"],
    ["claude-opus-4-7", "~$4.0"],
    ["claude-opus-4-6", "~$4.0"],
    ["claude-opus-4-5", "~$4.0"],
    ["claude-sonnet-5", "~$1.6"],
    ["claude-sonnet-4-6", "~$2.4"],
    ["claude-sonnet-4-5", "~$2.4"],
    ["claude-haiku-4-5", "~$0.8"],
]) {
    test(`${model} uses its specified input price`, (t) => {
        let f = fixture(t, [assistant({ model })]);
        assert.ok(block(f).includes(`(${cost} at API prices)`));
    });
}

test("large contexts and idle times use millions and days", (t) => {
    let f = fixture(t, [assistant({ tokens: 1200000, idleSeconds: 52 * 3600 })]);
    let reason = block(f);
    assert.match(reason, /~1\.2M/);
    assert.match(reason, /2d 4h/);
});

test("idle times below 48 hours stay in hours and minutes", (t) => {
    let f = fixture(t, [assistant({ idleSeconds: 47 * 3600 + 12 * 60 })]);
    assert.match(block(f), /47h 12m/);
});

test("costs of 100 dollars or more use whole dollars", (t) => {
    let f = fixture(t, [assistant({ tokens: 10000000 })]);
    let reason = block(f);
    assert.match(reason, /~\$200 at API prices/);
    assert.match(reason, /~\$100(?:\n|$)/);
    assert.doesNotMatch(reason, /~\$(?:100|200)\.0/);
});

test("tiny costs use the less-than format", (t) => {
    let f = fixture(t, [assistant({ usage: { input_tokens: 1 } })]);
    assert.match(block(f, { env: { COLD_CACHE_GUARD_MIN_TOKENS: "1" } }), /<\$0\.1/);
});
