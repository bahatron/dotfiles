#!/usr/bin/env node
// Pause prompts in large conversations when their API cache is likely cold.
// Save the prompt before blocking, and restore it when the user types go.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRICES = new Map([
    ["claude-fable-5", 10],
    ["claude-fable-5-1", 10],
    ["claude-mythos-5", 10],
    ["claude-mythos-5-1", 10],
    ["claude-opus-5-5", 4],
    ["claude-opus-5", 5],
    ["claude-opus-4-8", 5],
    ["claude-opus-4-7", 5],
    ["claude-opus-4-6", 5],
    ["claude-opus-4-5", 5],
    ["claude-sonnet-5", 2],
    ["claude-sonnet-4-6", 3],
    ["claude-sonnet-4-5", 3],
    ["claude-haiku-4-5", 1],
]);

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value) {
    if (typeof value !== "string") throw new Error("Expected a string");
    return value;
}

function nonnegativeNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error("Expected a nonnegative number");
    }
    return value;
}

function setting(name, fallback) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!value.trim()) throw new Error("Empty setting");
    return nonnegativeNumber(Number(value));
}

async function readInput() {
    let text = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) text += chunk;
    const input = JSON.parse(text);
    if (!isObject(input)) throw new Error("Invalid input");
    return input;
}

async function cleanupSaved(state, now) {
    try {
        const entries = await readdir(state, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !/^saved-.*\.json$/.test(entry.name)) continue;
            try {
                const file = join(state, entry.name);
                const saved = JSON.parse(await readFile(file, "utf8"));
                if (now - nonnegativeNumber(saved.savedAt) > DAY_MS) await unlink(file);
            } catch {}
        }
    } catch {}
}

async function readSaved(file) {
    try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        if (!isObject(saved)) throw new Error("Invalid saved prompt");
        requireString(saved.prompt);
        requireString(saved.sessionId);
        requireString(saved.cwd);
        nonnegativeNumber(saved.savedAt);
        return saved;
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function consumeForce(state) {
    try {
        await unlink(join(state, "force-once"));
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

function qualifies(entry) {
    return isObject(entry) && entry.type === "assistant" && entry.isSidechain !== true &&
        isObject(entry.message) && entry.message.model !== undefined &&
        entry.message.model !== "<synthetic>" && entry.message.usage !== undefined;
}

function usageOf(entry) {
    const usage = entry.message.usage;
    if (!isObject(usage)) throw new Error("Invalid usage");
    return usage;
}

function tokenCount(usage, field) {
    return usage[field] === undefined ? 0 : nonnegativeNumber(usage[field]);
}

function writeTtl(entry) {
    const usage = usageOf(entry);
    const creation = usage.cache_creation === undefined ? {} : usage.cache_creation;
    if (!isObject(creation)) throw new Error("Invalid cache creation");
    const hour = tokenCount(creation, "ephemeral_1h_input_tokens");
    const short = tokenCount(creation, "ephemeral_5m_input_tokens");
    if (hour > 0) return 3600;
    if (short > 0) return 300;
    if (tokenCount(usage, "cache_creation_input_tokens") > 0) return 3600;
    return null;
}

function scanTail(text, now) {
    let last = null;
    let compactAfterLast = false;
    let ttl = null;
    let end = text.length;
    while (end > 0) {
        const start = text.lastIndexOf("\n", end - 1) + 1;
        const line = text.slice(start, end);
        end = start - 1;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!last && entry?.type === "system" && entry.subtype === "compact_boundary") {
            compactAfterLast = true;
        }
        if (!qualifies(entry)) continue;
        if (!last) last = entry;
        ttl = writeTtl(entry);
        if (ttl !== null) break;
    }
    if (!last) return null;
    const usage = usageOf(last);
    const tokens = nonnegativeNumber([
        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens",
    ].reduce((total, field) => total + tokenCount(usage, field), 0));
    const timestamp = Date.parse(requireString(last.timestamp));
    if (!Number.isFinite(timestamp)) throw new Error("Invalid timestamp");
    const model = requireString(last.message.model);
    if (!model) throw new Error("Missing model");
    return { tokens, model, idle: (now - timestamp) / 1000, ttl: ttl ?? 3600, compactAfterLast };
}

async function readTail(file, size, limit) {
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
    }
    const text = buffer.toString("utf8", 0, offset);
    if (!start) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
}

async function readTranscript(transcript, now) {
    const file = await open(requireString(transcript), "r");
    try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("Not a transcript file");
        let result = scanTail(await readTail(file, info.size, 4 * MIB), now);
        if (!result) result = scanTail(await readTail(file, info.size, 32 * MIB), now);
        return result;
    } finally {
        await file.close();
    }
}

async function savePrompt(state, file, saved) {
    await mkdir(state, { recursive: true });
    const temporary = join(state, `.saved-${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
    } finally {
        try {
            await unlink(temporary);
        } catch {}
    }
}

function formatIdle(seconds) {
    const minutes = Math.max(0, Math.floor(seconds / 60));
    const hours = Math.floor(minutes / 60);
    if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}

function formatTokens(tokens) {
    return tokens >= 1000000 ? `~${(tokens / 1000000).toFixed(1)}M` : `~${Math.round(tokens / 1000)}k`;
}

function formatDollars(amount) {
    if (amount < 0.1) return "<$0.1";
    return `~$${amount < 100 ? amount.toFixed(1) : Math.round(amount)}`;
}

function wrapLine(line) {
    const lines = [];
    while (line.length > 63) {
        let end = line.lastIndexOf(" ", 63);
        if (end <= 0) end = 63;
        lines.push(line.slice(0, end));
        line = line.slice(end).trimStart();
    }
    lines.push(line);
    return lines.join("\n");
}

function notice(session, saveMinutes) {
    const { tokens, model, idle, ttl } = session;
    const price = PRICES.get(model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, ""));
    const multiplier = ttl === 3600 ? 2 : 1.25;
    const send = price === undefined ? "" : formatDollars(tokens * multiplier * price / 1000000);
    const compact = price === undefined ? "" : formatDollars(tokens * price / 1000000);
    const clear = price === undefined ? "" : formatDollars(45000 * multiplier * price / 1000000);
    return [
        `Cache likely expired: idle ${formatIdle(idle)}, session holds ${formatTokens(tokens)} tokens.`,
        `Sending now rewrites all of it${send ? ` (${send} at API prices)` : ""}.`,
        `  /compact, then go   keep a summary${compact ? `   ${compact}` : ""}`,
        `  /clear, then go     start fresh${clear ? `      ${clear}` : ""}`,
        `  go                  send as is${send ? `       ${send}` : ""}`,
        `Prompt saved for ${saveMinutes} min. Type go to send it.`,
    ].map(wrapLine).join("\n");
}

async function run() {
    if (["off", "0"].includes(process.env.COLD_CACHE_GUARD)) return;
    const input = await readInput();
    if (Object.hasOwn(input, "agent_id")) return;
    const cwd = requireString(input.cwd);
    const sessionId = requireString(input.session_id);
    const prompt = requireString(Object.hasOwn(input, "user_input") ? input.user_input : input.prompt);
    if (!cwd) return;
    const state = process.env.COLD_CACHE_GUARD_STATE_DIR || join(homedir(), ".cache", "cold-cache-guard");
    const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
    const savedFile = join(state, `saved-${hash}.json`);
    const saveMinutes = setting("COLD_CACHE_GUARD_SAVE_MINUTES", 30);
    const now = Date.now();
    await cleanupSaved(state, now);
    if (["go", "go.", "go!"].includes(prompt.trim().toLowerCase())) {
        const saved = await readSaved(savedFile);
        if (saved) {
            if (saved.cwd !== cwd) return;
            await unlink(savedFile);
            if (now - saved.savedAt < saveMinutes * 60000) {
                return {
                    hookSpecificOutput: {
                        hookEventName: "UserPromptSubmit",
                        additionalContext: "Cold-cache guard: the user typed \"go\" to send the prompt the guard paused earlier. Treat the text below as the user's message and respond to it.\n\n" + saved.prompt,
                    },
                };
            }
        }
    }
    const forced = await consumeForce(state);
    let session;
    try {
        session = await readTranscript(input.transcript_path, now);
    } catch (error) {
        if (!forced) throw error;
    }
    if (forced) {
        session ??= { tokens: 400000, model: "unknown", ttl: 3600, idle: 10800 };
    } else {
        if (!session || session.compactAfterLast) return;
        const margin = session.ttl === 3600 ? 120 : 30;
        const minimum = setting("COLD_CACHE_GUARD_MIN_TOKENS", 150000);
        if (session.idle <= session.ttl - margin || session.tokens < minimum) return;
    }
    await savePrompt(state, savedFile, { prompt, savedAt: now, sessionId, cwd });
    return { decision: "block", reason: notice(session, saveMinutes) };
}

const watchdog = setTimeout(() => process.exit(0), 3000);
process.stdout.on("error", () => process.exit(0));
try {
    const output = await run();
    if (output) {
        await new Promise((resolve) => process.stdout.write(`${JSON.stringify(output)}\n`, resolve));
    }
} catch {} finally {
    clearTimeout(watchdog);
    process.exit(0);
}
