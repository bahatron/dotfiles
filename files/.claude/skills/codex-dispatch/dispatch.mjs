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
const EXIT_ROUTED_TO_OPUS = 75;
const EXIT_LIMIT_HIT = 76;
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
    let root = join(homedir(), ".vscode", "extensions");
    let dirs = existsSync(root)
        ? readdirSync(root)
              .filter((d) => d.startsWith("openai.chatgpt-"))
              .sort()
              .reverse()
        : [];
    for (let d of dirs) {
        let p = join(root, d, "bin", "linux-x86_64", "codex");
        if (existsSync(p)) return p;
    }
    throw new Error(`codex binary not found under ${root}`);
}

export async function quota(threshold = DEFAULT_THRESHOLD) {
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
        let capped = used >= threshold || reached !== null || allowed === false;
        return {
            route: capped ? "opus" : "codex",
            used_percent: used,
            threshold,
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
            route: "codex",
            used_percent: null,
            threshold,
            error: String(error.message || error).replace(/\s+/g, " ").slice(0, 160),
        };
    } finally {
        clearTimeout(timer);
        child?.stdin.destroy();
        child?.stdout.destroy();
        child?.kill("SIGKILL");
    }
}

async function run(opts) {
    for (let k of ["prompt", "sandbox", "out"])
        if (!opts[k]) fail(`--${k} is required`);
    let threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
    if (!opts["force-codex"]) {
        let q = await quota(threshold);
        if (q.route === "opus") {
            emit({ route: "opus", ran: false, ...q });
            process.exit(EXIT_ROUTED_TO_OPUS);
        }
    }
    let cwd = opts.cwd ?? process.cwd();
    let args = ["exec", "-s", opts.sandbox, "-C", cwd, "-o", opts.out];
    if (opts.schema) args.push("--output-schema", opts.schema);
    if (opts.model) args.push("-m", opts.model);
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
    let after = !outExists ? await quota(threshold) : null;
    let limitHit =
        !outExists &&
        (LIMIT_PATTERN.test(text) || after.route === "opus");
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
if (cmd === "quota") emit(await quota(Number(opts.threshold ?? DEFAULT_THRESHOLD)));
else if (cmd === "run") await run(opts);
else
    fail(
        "usage: dispatch.mjs quota [--threshold N] | run --prompt FILE --sandbox MODE --out FILE [--schema FILE] [--label NAME] [--cwd DIR] [--timeout-s N] [--model M] [--threshold N] [--force-codex]",
    );
