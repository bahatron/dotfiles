#!/usr/bin/env node
// Assistant mode: enforce the main loop; leave workers alone.

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(homedir(), ".claude", "assistant-hook.log");

function main() {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    if (!payload || typeof payload !== "object" || Object.hasOwn(payload, "agent_id")) return;
    if (typeof payload.scratchpad_dir !== "string" || !payload.scratchpad_dir) return;

    const scratch = payload.scratchpad_dir;
    if (!existsSync(join(scratch, "assistant-mode"))) return;

    const event = payload.hook_event_name;
    const tool = payload.tool_name;
    const input = payload.tool_input ?? {};
    const command = typeof input.command === "string" ? input.command : "";
    const spoken = join(scratch, "assistant-spoken");

    function emit(decision, output) {
        const name = String(tool ?? "-").replace(/\s+/g, " ");
        appendFileSync(LOG, `${new Date().toISOString()} ${event} ${name} ${decision}\n`);
        process.stdout.write(typeof output === "string" ? `${output}\n` : JSON.stringify(output));
    }

    function deny(reason) {
        emit("deny", {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
            },
        });
    }

    if (event === "SessionStart" && ["compact", "resume", "startup"].includes(payload.source)) {
        emit("context", "Assistant mode is on for this session. Before replying, invoke the Skill tool with assistant, then chat. Speak every reply with the assistant skill's detached pattern. Workers launched earlier keep running; report their results when they land.");
    } else if (event === "PreToolUse") {
        if (tool === "Agent" && (input.model !== "opus" || input.subagent_type === "fork")) {
            const updatedInput = { ...input, model: "opus" };
            if (input.subagent_type === "fork") updatedInput.subagent_type = "general-purpose";
            emit("updatedInput", {
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                    updatedInput,
                },
            });
        } else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
            deny("Assistant mode: the main loop never edits files. Launch a background Opus worker with the Agent tool and the task card from the assistant skill, then tell Simon it is queued.");
        } else if (tool === "Bash" && /\bcodex["']?\s+exec\b|\bdispatch\.mjs["']?\s+run\b/.test(command)) {
            deny("Assistant mode: the main loop never launches Codex. Hand the task to a background Opus worker; the worker runs the gate and Codex.");
        } else if (tool === "TaskStop") {
            const promptPath = join(scratch, "assistant-last-prompt");
            if (existsSync(promptPath) && !/\b(stop|cancel|kill|abort|halt)\b|never mind|don'?t bother/i.test(readFileSync(promptPath, "utf8"))) {
                deny("Assistant mode: Simon's last words did not say stop, cancel or kill. Steer the worker instead: SendMessage his words to it verbatim; it keeps the ask, its reads and its checks. If he did mean cancel, ask him.");
            }
        }
    } else if (event === "PostToolUse" && tool === "Bash" && /\bspeak\b/.test(command)) {
        writeFileSync(spoken, "");
    } else if (event === "UserPromptSubmit") {
        writeFileSync(join(scratch, "assistant-last-prompt"), typeof payload.prompt === "string" ? payload.prompt : "");
    } else if (event === "Stop") {
        if (existsSync(join(scratch, "assistant-mute"))) return;
        if (existsSync(spoken)) {
            unlinkSync(spoken);
            return;
        }
        if (payload.stop_hook_active === true) return;
        emit("block", {
            decision: "block",
            reason: "Assistant mode: this reply was not spoken. Run the detached speak pattern from the assistant skill with one or two sentences for the ear, then stop.",
        });
    }
}

try {
    main();
} catch {}
