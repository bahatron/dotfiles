#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
    existsSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_THRESHOLD = 95;
const DEFAULT_CLAUDE_THRESHOLD = 90;
const EXIT_ROUTED_TO_OPUS = 75;
const EXIT_LIMIT_HIT = 76;
const EXIT_ROUTED_TO_STOP = 77;
const LIMIT_PATTERN =
    /usage limit|usage_limit|rate.?limit(ed|_reached)|too many requests|insufficient_quota|\b429\b/i;

function parseArgs(argv) {
    let out = {};
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (!a.startsWith("--")) continue;
        let key = a.slice(2);
        let next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) out[key] = true;
        else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

function codexBinary() {
    let os = process.platform === "darwin" ? "macos" :
        process.platform === "linux" ? "linux" : null;
    if (!os) throw new Error(`unsupported platform: ${process.platform}`);
    let arch = process.arch === "x64" ? "x86_64" :
        process.arch === "arm64" ? "aarch64" : null;
    if (!arch) throw new Error(`unsupported architecture: ${process.arch}`);
    let directory = `${os}-${arch}`;
    let root = join(homedir(), ".vscode", "extensions");
    let dirs = existsSync(root)
        ? readdirSync(root)
              .filter((d) => d.startsWith("openai.chatgpt-"))
              .sort()
              .reverse()
        : [];
    for (let d of dirs) {
        let p = join(root, d, "bin", directory, "codex");
        if (existsSync(p)) return p;
    }
    throw new Error(`codex binary not found under ${root} in bin/${directory}`);
}

async function codexUsage() {
    let started = Date.now();
    let child;
    let timer;
    try {
        let result = await new Promise((resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error("app-server timed out after 20 s")),
                20000,
            );
            child = spawn(codexBinary(), ["app-server", "--stdio"], {
                stdio: ["pipe", "pipe", "ignore"],
            });
            let buffer = "";
            let id = 1;
            let send = (message) => {
                child.stdin.write(`${JSON.stringify(message)}\n`);
            };
            child.on("error", reject);
            child.stdin.on("error", reject);
            child.stdout.on("error", reject);
            child.on("close", () => {
                reject(new Error("app-server closed before responding"));
            });
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (data) => {
                buffer += data;
                let i;
                while ((i = buffer.indexOf("\n")) >= 0) {
                    let line = buffer.slice(0, i);
                    buffer = buffer.slice(i + 1);
                    if (!line.trim()) continue;
                    try {
                        let message = JSON.parse(line);
                        if (message?.id !== id) continue;
                        if (message.error)
                            throw new Error(
                                message.error.message || "app-server JSON-RPC error",
                            );
                        if (!message.result || typeof message.result !== "object" ||
                            Array.isArray(message.result))
                            throw new Error("malformed app-server response");
                        if (id === 2) return resolve(message.result);
                        id = 2;
                        send({ method: "initialized", params: {} });
                        send({
                            id,
                            method: "account/rateLimits/read",
                            params: { excludeResetCreditDetails: true },
                        });
                    } catch (error) {
                        return reject(error);
                    }
                }
            });
            send({
                id,
                method: "initialize",
                params: {
                    clientInfo: {
                        name: "codex-dispatch",
                        title: "codex-dispatch",
                        version: "1.0.0",
                    },
                },
            });
        });
        let rl = result.rateLimits;
        let w = rl?.primary;
        if (!w || typeof w !== "object" || Array.isArray(w) ||
            !Number.isFinite(w.usedPercent) || w.usedPercent < 0)
            throw new Error("malformed rate limits response");
        let used = w.usedPercent;
        let reached = typeof rl.rateLimitReachedType === "string" ? rl.rateLimitReachedType : null;
        let allowed = typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null;
        return {
            used_percent: used,
            window_minutes: Number.isInteger(w.windowDurationMins) ? w.windowDurationMins : null,
            resets_at: Number.isInteger(w.resetsAt)
                ? new Date(w.resetsAt * 1000).toISOString()
                : null,
            limit_reached: reached,
            usage_allowed: allowed,
            limit_id: typeof rl.limitId === "string" ? rl.limitId : null,
            plan: typeof rl.planType === "string" ? rl.planType : null,
            ms: Date.now() - started,
        };
    } catch (error) {
        return {
            used_percent: null,
            error: String(error.message || error).replace(/\s+/g, " ").slice(0, 160),
        };
    } finally {
        clearTimeout(timer);
        child?.stdin.destroy();
        child?.stdout.destroy();
        child?.kill("SIGKILL");
    }
}

async function claudeUsage(threshold = DEFAULT_CLAUDE_THRESHOLD) {
    let started = Date.now();
    try {
        let raw;
        if (process.platform === "darwin") {
            let login = spawnSync("security", [
                "find-generic-password", "-s", "Claude Code-credentials", "-w",
            ], { encoding: "utf8", timeout: 10000 });
            if (login.status !== 0) throw new Error("Claude login could not be read");
            raw = login.stdout;
        } else {
            raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
        }
        let credentials;
        try {
            credentials = JSON.parse(raw);
        } catch {
            throw new Error("Claude login is not valid JSON");
        }
        let token = credentials?.claudeAiOauth?.accessToken;
        if (typeof token !== "string" || !token)
            throw new Error("Claude access token is missing");
        let response;
        try {
            response = await fetch("https://api.anthropic.com/api/oauth/usage", {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "anthropic-beta": "oauth-2025-04-20",
                },
                signal: AbortSignal.timeout(20000),
            });
        } catch {
            throw new Error("Claude usage request failed");
        }
        if (!response.ok) throw new Error(String(response.status));
        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error("malformed usage response");
        }
        let five = result?.five_hour;
        let seven = result?.seven_day;
        let fiveUsed = Number.isFinite(five?.utilization) && five.utilization >= 0
            ? five.utilization : null;
        let sevenUsed = Number.isFinite(seven?.utilization) && seven.utilization >= 0
            ? seven.utilization : null;
        if (fiveUsed === null && sevenUsed === null)
            throw new Error("malformed usage response");
        let higher = fiveUsed !== null && (sevenUsed === null || fiveUsed >= sevenUsed)
            ? five : seven;
        let resets = null;
        if (higher.resets_at !== undefined && higher.resets_at !== null) {
            try {
                resets = new Date(higher.resets_at).toISOString();
            } catch {}
        }
        return {
            used_percent: Math.max(fiveUsed ?? 0, sevenUsed ?? 0),
            threshold,
            five_hour: fiveUsed,
            seven_day: sevenUsed,
            resets_at: resets,
            ms: Date.now() - started,
        };
    } catch (error) {
        return {
            used_percent: null,
            threshold,
            error: String(error.message || error).replace(/\s+/g, " ").slice(0, 160),
        };
    }
}

export function decide(codex, claude, threshold, claudeThreshold) {
    let claudeLow = typeof claude.used_percent === "number" && claude.used_percent >= claudeThreshold;
    let effectiveThreshold = claudeLow ? 100 : threshold;
    let codexCapped = typeof codex.used_percent === "number" &&
        (codex.used_percent >= effectiveThreshold ||
            codex.limit_reached !== null || codex.usage_allowed === false);
    return {
        route: !codexCapped ? "codex" : claudeLow ? "stop" : "opus",
        review: claudeLow ? "codex" : "opus",
        threshold: effectiveThreshold,
    };
}

export async function quota(threshold = DEFAULT_THRESHOLD, claudeThreshold = DEFAULT_CLAUDE_THRESHOLD) {
    let [codex, claude] = await Promise.all([codexUsage(), claudeUsage(claudeThreshold)]);
    let decision = decide(codex, claude, threshold, claudeThreshold);
    let { used_percent, ...reading } = codex;
    return {
        route: decision.route,
        review: decision.review,
        used_percent,
        threshold: decision.threshold,
        ...reading,
        claude,
    };
}

async function run(opts) {
    for (let k of ["prompt", "sandbox", "out"])
        if (!opts[k]) fail(`--${k} is required`);
    let threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
    let claudeThreshold = Number(opts["claude-threshold"] ?? DEFAULT_CLAUDE_THRESHOLD);
    if (!opts["force-codex"]) {
        let q = await quota(threshold, claudeThreshold);
        if (q.route === "opus" || q.route === "stop") {
            emit({ ran: false, ...q });
            process.exit(q.route === "stop" ? EXIT_ROUTED_TO_STOP : EXIT_ROUTED_TO_OPUS);
        }
    }
    let cwd = opts.cwd ?? process.cwd();
    let args = ["exec", "-s", opts.sandbox, "-C", cwd, "-o", opts.out];
    if (opts.schema) args.push("--output-schema", opts.schema);
    if (opts.model) args.push("-m", opts.model);
    // Codex refuses to run outside a git repository unless told to; folders of
    // plain documents (bauer/) are not repositories.
    let inRepo = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status === 0;
    if (!inRepo) args.push("--skip-git-repo-check");
    args.push("-");
    let started = Date.now();
    let res = spawnSync(codexBinary(), args, {
        input: readFileSync(opts.prompt),
        timeout: Number(opts["timeout-s"] ?? 900) * 1000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
    });
    let text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    let log = `${opts.out}.log`;
    writeFileSync(log, text);
    let outExists = existsSync(opts.out) && statSync(opts.out).size > 0;
    let after = !outExists ? await quota(threshold, claudeThreshold) : null;
    let limitHit =
        !outExists &&
        (LIMIT_PATTERN.test(text) || after.route !== "codex");
    emit({
        route: "codex",
        ran: true,
        label: opts.label ?? null,
        exit: res.status,
        signal: res.signal,
        timed_out: res.error?.code === "ETIMEDOUT",
        seconds: Math.round((Date.now() - started) / 1000),
        out: opts.out,
        out_exists: outExists,
        log,
        limit_hit: limitHit,
        ...(after ? { gate_after: after } : {}),
    });
    if (limitHit) process.exit(EXIT_LIMIT_HIT);
    process.exit(outExists && res.status === 0 ? 0 : res.status || 1);
}

function emit(o) {
    process.stdout.write(`${JSON.stringify(o)}\n`);
}

function fail(msg) {
    process.stderr.write(`${msg}\n`);
    process.exit(2);
}

let [cmd, ...rest] = process.argv.slice(2);
let opts = parseArgs(rest);
if (cmd === "quota") emit(await quota(
    Number(opts.threshold ?? DEFAULT_THRESHOLD),
    Number(opts["claude-threshold"] ?? DEFAULT_CLAUDE_THRESHOLD),
));
else if (cmd === "run") await run(opts);
else
    fail(
        "usage: dispatch.mjs quota [--threshold N] [--claude-threshold N] | run --prompt FILE --sandbox MODE --out FILE [--schema FILE] [--label NAME] [--cwd DIR] [--timeout-s N] [--model M] [--threshold N] [--claude-threshold N] [--force-codex]",
    );
