export type ColdCacheGuardTranscriptPath = string | null;

declare module "claude-code" {
    interface PluginState {
        "cold-cache-guard": {
            transcriptPath: ColdCacheGuardTranscriptPath;
            pendingPrompts: { id: string; prompt: PromptSubmitInput; compactionAttempted?: boolean }[];
        };
    }
}
