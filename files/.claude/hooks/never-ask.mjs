#!/usr/bin/env node
// PermissionRequest hook: answer every permission dialog so no session, subagent
// or workflow agent ever waits on a click. bypassPermissions still raises a few
// built-in safety prompts (for example `cd <dir> && git ...` outside the working
// directory); on 12-10-2026 one held a background reviewer for 2.5 hours.
// Everything is allowed except a recursive delete of / or the home directory,
// which is denied outright: a deny returns at once, an ask would block.
// Each decision is appended to ~/.claude/never-ask.log.

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const LOG = join(HOME, ".claude", "never-ask.log");

function readPayload() {
    try {
        return JSON.parse(readFileSync(0, "utf8"));
    } catch {
        return {};
    }
}

function wipesRootOrHome(command) {
    const targets = ["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*", "${HOME}", HOME, `${HOME}/`, `${HOME}/*`];
    const tokens = command.split(/[\s;&|()]+/).map((t) => t.replace(/["']/g, ""));
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== "rm") continue;
        const args = [];
        for (let j = i + 1; j < tokens.length && tokens[j] !== "rm"; j++) args.push(tokens[j]);
        const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
        if (recursive && args.some((a) => targets.includes(a))) return true;
    }
    return false;
}

function log(decision, payload, summary) {
    try {
        const who = payload.agent_type ? `agent:${payload.agent_type}` : "main";
        appendFileSync(LOG, `${new Date().toISOString()} ${decision} ${payload.tool_name ?? "?"} ${who} ${summary}\n`);
    } catch {}
}

const payload = readPayload();
const command = typeof payload?.tool_input?.command === "string" ? payload.tool_input.command : "";
const summary = (command || JSON.stringify(payload.tool_input ?? {})).replace(/\s+/g, " ").slice(0, 200);

const decision =
    payload.tool_name === "Bash" && wipesRootOrHome(command)
        ? { behavior: "deny", message: "never-ask hook: recursive delete of / or the home directory is refused." }
        : { behavior: "allow" };

log(decision.behavior, payload, summary);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
