---
name: chat
description: Hold a spoken, voice-based conversation with the user — reply out loud via the `speak` TTS command instead of writing text answers. Use whenever the user wants to talk rather than read: triggers include "let's have a chat", "let's talk", "can we chat", "talk to me", "let's have a conversation", "voice chat". Once active, every reply stays in voice mode until the user says to stop (e.g. "stop chatting", "back to text", "that's enough").
---

# Chat — voice mode

The user wants to *talk*, not read. Speak each reply aloud with the `speak` command rather than writing it out as text. (`speak` is a Piper neural-TTS wrapper at `~/.local/bin/speak`.)

## Every turn

1. Compose a short, natural, spoken reply — the way you'd *say* it, not write it. One to four sentences. Keep the conversation going with the occasional question.
2. Speak it using a quoted heredoc, so apostrophes, quotes, and punctuation can never break the shell:

   ```bash
   speak <<'SPEAK'
   Hey Simon, good to hear you. What's on your mind?
   SPEAK
   ```

3. Don't also write the reply out as a text block — the conversation lives in the audio. At most, leave a single short transcript line if it helps.

## Make it sound human

- Write for the ear: plain spoken sentences only. No markdown, bullets, emoji, code, URLs, or file paths — they sound awful read aloud.
- Keep turns brief and trade lines like a real chat. Avoid long monologues.
- Be warm and personable. Match the user's tone and energy.
- Expand things that don't speak well: say "number five", "dot js", "the README", and so on.

## When a reply genuinely needs text

If the user asks for code, a command to copy, a table, or a link, show that part as normal on-screen text and speak a short pointer like "I've put it on screen for you." Then carry on in voice.

## Start & stop

- On entering chat mode, open with a brief spoken greeting and invite them to talk.
- Stay in voice mode for every following reply.
- Leave only on a clear signal — "stop chatting", "back to text", "that's enough" — then say a short spoken goodbye and resume normal text replies.

## Voice override

Default voice is `en_US-lessac-medium`. To use another installed voice for the session, prefix the command:

```bash
PIPER_VOICE=~/.local/share/piper/voices/en_US-ryan-high.onnx speak <<'SPEAK'
Switching to a different voice for this chat.
SPEAK
```
