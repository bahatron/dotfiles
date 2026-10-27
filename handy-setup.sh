#!/bin/sh
# Installs Handy and Canary 180M Flash for offline dictation on macOS.
# Safe to re-run; also called by setup.sh.
# The model pin is Handy 0.9.8's catalog entry tested on this Mac on 27-10-2026.
# Canary 180M Flash replaced Parakeet Unified EN 0.6B: it tested much better on this Mac (decided 27-10-2026).
MODEL_REPO=handy-computer/canary-180m-flash-gguf
MODEL_REVISION=b147f9dc52b59f0998e410540a84727bd86457fd
MODEL_FILE=canary-180m-flash-Q8_0.gguf
MODEL_SHA256=e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c
set -eu

notify() {
    echo "================================================ ${1}"
}

## Operating system
OS=$(uname -s)
case "$OS" in
    Linux|Darwin) ;;
    *)
        printf 'Unsupported OS: %s\n' "$OS" >&2
        exit 1
        ;;
esac

if [ "$OS" = Linux ]; then
    notify "Nothing to do on Linux: handy-setup.sh only covers macOS"
    exit 0
fi

if BREW=$(command -v brew) && [ -x "$BREW" ]; then
    :
elif [ -x /opt/homebrew/bin/brew ]; then
    BREW=/opt/homebrew/bin/brew
elif [ -x /usr/local/bin/brew ]; then
    BREW=/usr/local/bin/brew
else
    printf '%s\n' 'Homebrew executable not found; install Homebrew first.' >&2
    exit 1
fi
eval "$("$BREW" shellenv)"

if [ ! -d /Applications/Handy.app ]; then
    notify "Installing Handy..."
    "$BREW" install --cask handy
else
    notify "Handy already installed; skipping install"
fi
HANDY=/Applications/Handy.app/Contents/MacOS/handy
MODEL_ID="$MODEL_REPO/$MODEL_FILE"
MODEL_DIR="$HOME/Library/Application Support/com.pais.handy/models"

SMOKE_DIR=$(mktemp -d)
trap 'rm -rf "$SMOKE_DIR"' 0
trap 'exit 130' INT
trap 'exit 143' TERM

if "$HANDY" --list-models --json > "$SMOKE_DIR/models.json" 2> /dev/null &&
    /usr/bin/jq -e --arg id "$MODEL_ID" \
        'any(.[]; .id == $id and .is_downloaded == true)' "$SMOKE_DIR/models.json" > /dev/null; then
    notify "Canary 180M Flash already installed; skipping download"
else
    notify "Downloading Canary 180M Flash (218 MB)..."
    curl --fail --location --output "$SMOKE_DIR/$MODEL_FILE" \
        "https://huggingface.co/$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_FILE"
    ACTUAL_SHA256=$(shasum -a 256 "$SMOKE_DIR/$MODEL_FILE" | awk '{print $1}')
    if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
        printf 'Model checksum mismatch: expected %s, got %s\n' "$MODEL_SHA256" "$ACTUAL_SHA256" >&2
        exit 1
    fi
    mkdir -p "$MODEL_DIR"
    mv -n "$SMOKE_DIR/$MODEL_FILE" "$MODEL_DIR/$MODEL_FILE"
fi

notify "Testing Handy with Canary 180M Flash..."
say -o "$SMOKE_DIR/ready.wav" --data-format=LEI16@16000 "The dictation model is ready."
SMOKE_OK=0
if "$HANDY" --transcribe-file "$SMOKE_DIR/ready.wav" --model "$MODEL_ID" --json \
    > "$SMOKE_DIR/transcript.json" 2> "$SMOKE_DIR/handy.log"; then
    SMOKE_OK=1
fi
TRANSCRIPT=$(/usr/bin/jq -r '.text // empty' "$SMOKE_DIR/transcript.json" 2> /dev/null) || TRANSCRIPT=
if [ "$SMOKE_OK" -ne 1 ] || ! printf '%s\n' "$TRANSCRIPT" | grep -iq ready; then
    printf '%s\n' 'Handy smoke test failed' >&2
    if [ -n "$TRANSCRIPT" ]; then
        printf '%s\n' "$TRANSCRIPT" >&2
    fi
    cat "$SMOKE_DIR/handy.log" >&2
    exit 1
fi
notify "Handy heard: $TRANSCRIPT"
notify "Handy and Canary 180M Flash are ready!"
