import { update } from "claude-code";
import type { EngineInterface, Register, Timer } from "claude-code";
import type { ColdCacheGuardTranscriptPath } from "../types/index";

const MIB = 1024 * 1024;
const transcriptPath = { plugin: "cold-cache-guard", key: "transcriptPath" } as const;
const pendingPrompts = { plugin: "cold-cache-guard", key: "pendingPrompts" } as const;

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown) {
    if (typeof value !== "string") throw new Error("Expected a string");
    return value;
}

function nonnegativeNumber(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error("Expected a nonnegative number");
    }
    return value;
}

type AssistantEntry = Record<string, unknown> & { message: Record<string, unknown> };

function qualifies(entry: unknown): entry is AssistantEntry {
    return isObject(entry) && entry.type === "assistant" && entry.isSidechain !== true &&
        isObject(entry.message) && entry.message.model !== undefined &&
        entry.message.model !== "<synthetic>" && entry.message.usage !== undefined;
}

function usageOf(entry: AssistantEntry) {
    const usage = entry.message.usage;
    if (!isObject(usage)) throw new Error("Invalid usage");
    return usage;
}

function tokenCount(usage: Record<string, unknown>, field: string) {
    return usage[field] === undefined ? 0 : nonnegativeNumber(usage[field]);
}

function writeTtl(entry: AssistantEntry) {
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

export function scanTail(text: string, now: number) {
    let last: AssistantEntry | null = null;
    let compactAfterLast = false;
    let ttl = null;
    let end = text.length;
    while (end > 0) {
        const start = text.lastIndexOf("\n", end - 1) + 1;
        const line = text.slice(start, end);
        end = start - 1;
        let entry: unknown;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!last && isObject(entry) && entry.type === "system" && entry.subtype === "compact_boundary") {
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

// $.fs has no ranged reads. Stage the bounded window in chunks below its 4 MiB cap.
const stageTail = `set -eu
directory=$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/cold-cache-guard.XXXXXXXX")
trap '/bin/rm -rf "$directory"' 0
/bin/dd if="$1" of="$directory/window" bs=1048576 skip="$(($2 / 1048576))" count="$((($2 % 1048576 + $3 + 1048575) / 1048576))" 2>/dev/null
/usr/bin/tail -c "+$(($2 % 1048576 + 1))" "$directory/window" | /usr/bin/head -c "$3" | /usr/bin/split -b 1048576 - "$directory/chunk-"
printf '%s' "$directory"
trap - 0`;

export async function readTail($: EngineInterface, transcript: string, size: number, limit: number) {
    const start = Math.max(0, size - limit);
    let text;
    if (size <= 4 * MIB) {
        text = await $.fs.read(transcript);
    } else {
        const staged = await $.process.run([
            "/bin/sh", "-c", stageTail, "cold-cache-guard", transcript, String(start), String(size - start),
        ]);
        if (staged.exitCode !== 0) throw new Error("Could not stage transcript tail");
        const directory = staged.stdout;
        try {
            const entries = (await $.fs.list(directory)).filter((entry) => entry.name.startsWith("chunk-"));
            entries.sort((left, right) => left.name.localeCompare(right.name));
            const bytes = new Uint8Array(size - start);
            let offset = 0;
            for (const entry of entries) {
                const { base64 } = await $.fs.read(`${directory}/${entry.name}`, { as: "bytes" });
                const chunk = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            text = new TextDecoder().decode(bytes.subarray(0, offset));
        } finally {
            await $.process.run(["/bin/rm", "-rf", directory]);
        }
    }
    if (!start) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
}

async function readTranscript($: EngineInterface, transcript: string, now: number) {
    const info = await $.fs.stat(transcript);
    if (info.kind !== "file") throw new Error("Not a transcript file");
    let result = scanTail(await readTail($, transcript, info.size, 4 * MIB), now);
    if (!result) result = scanTail(await readTail($, transcript, info.size, 32 * MIB), now);
    return result;
}

async function consumeForce($: EngineInterface) {
    const home = await $.env.get("HOME");
    if (!home) return false;
    const file = `${home}/.cache/cold-cache-guard/force-once`;
    if (!await $.fs.exists(file)) return false;
    const result = await $.process.run(["/bin/rm", file]);
    if (result.exitCode !== 0) throw new Error("Could not consume force-once");
    return true;
}

export function formatIdle(seconds: number) {
    const minutes = Math.max(0, Math.floor(seconds / 60));
    const hours = Math.floor(minutes / 60);
    if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}

export function formatTokens(tokens: number) {
    return tokens >= 1000000 ? `~${(tokens / 1000000).toFixed(1)}M` : `~${Math.round(tokens / 1000)}k`;
}

function oneLine(reason: unknown) {
    return String(reason instanceof Error ? reason.message : reason).replace(/[\r\n]+/g, " ");
}

export const register: Register = (on, options) => {
    let schedule: (() => void) | null = null;
    let timer: Timer | null = null;
    let busy = false;
    let requested = false;
    const delivered = new Set<string>();

    on("session.start", async ($, e, next) => {
        const drain = async () => {
            timer = null;
            if (busy) return;
            busy = true;
            requested = false;
            try {
                const { value = [] } = await $.state.get(pendingPrompts);
                const job = value[0];
                if (!job) return;
                try {
                    if (!job.compactionAttempted) {
                        await update($, pendingPrompts, (jobs) => (jobs ?? []).map((pending) =>
                            pending.id === job.id ? { ...pending, compactionAttempted: true } : pending));
                        const result = await $.session.compact();
                        if (result.skip !== undefined) {
                            $.ui.toast(`Compaction skipped: ${oneLine(result.skip)}; sending your prompt`);
                        }
                    }
                } catch (error) {
                    $.ui.toast(`Compaction failed: ${oneLine(error)}; sending your prompt`);
                } finally {
                    if (!delivered.has(job.id)) {
                        const result = await $.prompt.submit({
                            text: job.prompt.text,
                            attachments: job.prompt.attachments,
                            asUser: true,
                        });
                        if ("drop" in result) throw new Error(result.drop);
                        delivered.add(job.id);
                    }
                    let more = false;
                    await update($, pendingPrompts, (jobs) => {
                        const remaining = (jobs ?? []).filter((pending) => pending.id !== job.id);
                        more = remaining.length > 0;
                        return remaining;
                    });
                    delivered.delete(job.id);
                    if (more) timer = $.clock.after(0, drain);
                }
            } catch (error) {
                try {
                    $.ui.toast(`Prompt still queued: ${oneLine(error)}; retrying automatically`);
                } catch {}
                timer = $.clock.after(1000, drain);
            } finally {
                busy = false;
                if (requested && !timer) schedule?.();
            }
        };
        schedule = () => {
            requested = true;
            if (!timer && !busy) timer = $.clock.after(0, drain);
        };
        if ((await $.state.get(pendingPrompts)).value?.length) schedule();
        return next(e);
    });

    on("classic.SessionStart", async ($, e, next) => {
        await $.state.set(transcriptPath, e.transcript_path);
        return next(e);
    });

    on("prompt.submit", async ($, e, next) => {
        try {
            if (e.command || e.isMeta || e.turnId !== undefined ||
                !["composer", "bridge", "sdk"].includes(e.origin.kind)) return next(e);
            const forced = await consumeForce($);
            const { value = null } = await $.state.get(transcriptPath);
            const path: ColdCacheGuardTranscriptPath = value;
            if (!path) return next(e);
            const session = await readTranscript($, path, await $.clock.now());
            if (!session || session.compactAfterLast) return next(e);
            const margin = session.ttl === 3600 ? 120 : 30;
            if (!forced && (session.idle <= session.ttl - margin || session.tokens < 150000)) return next(e);
            // This build's plugin submit bridge drops media even when attachments are passed.
            if (e.attachments?.length) {
                $.ui.toast("Compaction unavailable for attached prompts in this build; sending your prompt with attachments");
                return next(e);
            }
            if (!schedule) return next(e);
            $.ui.toast(`Cache expired (idle ${formatIdle(session.idle)}, ${formatTokens(session.tokens)} tokens): compacting before your prompt`);
            await update($, pendingPrompts, (jobs) => [...(jobs ?? []), { id: crypto.randomUUID(), prompt: e }]);
            schedule();
            return { drop: "Compacting first; your prompt follows automatically." };
        } catch {}
        return next(e);
    }).catch(($, e, next) => next(e));
};
