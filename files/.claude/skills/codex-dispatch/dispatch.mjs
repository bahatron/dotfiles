#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
    existsSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_THRESHOLD = 90;
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

function rollouts(limit) {
    let root = join(homedir(), ".codex", "sessions");
    let files = [];
    let walk = (dir) => {
        for (let e of readdirSync(dir, { withFileTypes: true })) {
            let p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".jsonl"))
                files.push({ path: p, mtime: statSync(p).mtimeMs });
        }
    };
    if (existsSync(root)) walk(root);
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function findKey(node, key) {
    if (!node || typeof node !== "object") return null;
    if (key in node) return node[key];
    for (let v of Object.values(node)) {
        let r = findKey(v, key);
        if (r) return r;
    }
    return null;
}

function readSnapshot() {
    for (let { path, mtime } of rollouts(40)) {
        let lines = readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => l.includes('"rate_limits"'));
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                let rl = findKey(JSON.parse(lines[i]), "rate_limits");
                if (rl)
                    return {
                        rollout: path,
                        ageMinutes: Math.round((Date.now() - mtime) / 60000),
                        rateLimits: rl,
                    };
            } catch {}
        }
    }
    return null;
}

export function quota(threshold = DEFAULT_THRESHOLD) {
    let s = readSnapshot();
    if (!s) {
        return {
            route: "codex",
            used_percent: null,
            threshold,
            note: "no rate_limits snapshot found; assuming Codex is available",
        };
    }
    let w = s.rateLimits.primary || s.rateLimits.secondary || {};
    let used = typeof w.used_percent === "number" ? w.used_percent : null;
    let resetMs = w.resets_at ? w.resets_at * 1000 : null;
    let resetPassed = resetMs !== null && Date.now() > resetMs;
    let reached = s.rateLimits.rate_limit_reached_type || null;
    let capped =
        !resetPassed &&
        (reached !== null || (used !== null && used >= threshold));
    return {
        route: capped ? "opus" : "codex",
        used_percent: used,
        threshold,
        window_minutes: w.window_minutes ?? null,
        resets_at: resetMs !== null ? new Date(resetMs).toISOString() : null,
        reset_passed: resetPassed,
        limit_reached: reached,
        snapshot_age_minutes: s.ageMinutes,
        rollout: s.rollout,
    };
}

function run(opts) {
    for (let k of ["prompt", "sandbox", "out"])
        if (!opts[k]) fail(`--${k} is required`);
    let threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
    if (!opts["force-codex"]) {
        let q = quota(threshold);
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
    let after = quota(threshold);
    let limitHit =
        !outExists &&
        (after.limit_reached !== null || LIMIT_PATTERN.test(text));
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
        used_percent_after: after.used_percent,
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
if (cmd === "quota") emit(quota(Number(opts.threshold ?? DEFAULT_THRESHOLD)));
else if (cmd === "run") run(opts);
else
    fail(
        "usage: dispatch.mjs quota [--threshold N] | run --prompt FILE --sandbox MODE --out FILE [--schema FILE] [--label NAME] [--cwd DIR] [--timeout-s N] [--model M] [--threshold N] [--force-codex]",
    );
