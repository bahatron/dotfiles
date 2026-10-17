#!/bin/sh
# Installs the chat skill's voice: Kokoro-82M on macOS or Piper on Linux through uv, the ~/.local/bin/speak link,
# and the macOS local.speak-server launchd agent. Safe to re-run; also called by setup.sh.
# The mlx-audio pin is the version tested on this Mac on 17-10-2026.
MLX_AUDIO_VERSION=0.5.9
# The piper-tts pin is the version tested on Linux on 17-10-2026.
PIPER_TTS_VERSION=1.8.0
BASEDIR=$(cd "$(dirname "$0")" && pwd)
set -eu

notify() {
    echo "================================================ ${1}"
}

## Operating system
OS=$(uname -s)
case "$OS" in
    Linux)
        PATH="$HOME/.local/bin:$PATH"
        export PATH
        if ! command -v uv > /dev/null 2>&1; then
            notify "Installing uv..."
            curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
        fi
        UV=$(command -v uv)
        TOOL_PYTHON="$("$UV" tool dir)/piper-tts/bin/python"
        if [ -x "$HOME/.local/bin/piper" ] && [ -x "$TOOL_PYTHON" ] &&
            "$TOOL_PYTHON" - "$PIPER_TTS_VERSION" <<'PY'
import sys
from importlib.metadata import version

try:
    assert sys.version_info[:2] == (3, 12)
    assert version("piper-tts") == sys.argv[1]
except Exception:
    sys.exit(1)
PY
        then
            notify "piper-tts $PIPER_TTS_VERSION on Python 3.12 already installed; skipping install"
        else
            notify "Installing piper-tts $PIPER_TTS_VERSION on Python 3.12..."
            UV_TOOL_BIN_DIR="$HOME/.local/bin" "$UV" tool install --force --python 3.12 "piper-tts==$PIPER_TTS_VERSION"
        fi

        VOICE_DIR="$HOME/.local/share/piper/voices"
        mkdir -p "$HOME/.local/bin" "$VOICE_DIR"
        SMOKE_DIR=$(mktemp -d)
        trap 'rm -rf "$SMOKE_DIR"' 0
        trap 'exit 130' INT
        trap 'exit 143' TERM
        for VOICE_FILE in en_US-lessac-medium.onnx en_US-lessac-medium.onnx.json; do
            if [ ! -e "$VOICE_DIR/$VOICE_FILE" ]; then
                notify "Downloading $VOICE_FILE..."
                curl --fail --location --output "$SMOKE_DIR/$VOICE_FILE" \
                    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/$VOICE_FILE"
                mv -n "$SMOKE_DIR/$VOICE_FILE" "$VOICE_DIR/$VOICE_FILE"
            else
                notify "$VOICE_FILE already exists; skipping download"
            fi
        done

        if ! command -v pw-play > /dev/null 2>&1 &&
            ! command -v paplay > /dev/null 2>&1 &&
            ! command -v aplay > /dev/null 2>&1; then
            notify "Installing alsa-utils for audio playback..."
            if [ "$(id -u)" -eq 0 ]; then
                apt-get update
                apt-get install -y alsa-utils
            else
                sudo apt-get update
                sudo apt-get install -y alsa-utils
            fi
        fi

        if [ -e "$HOME/.local/bin/speak" ] && [ ! -L "$HOME/.local/bin/speak" ]; then
            if [ -e "$HOME/.local/bin/speak.pre-dotfiles" ] || [ -L "$HOME/.local/bin/speak.pre-dotfiles" ]; then
                printf '%s\n' "Cannot back up speak: $HOME/.local/bin/speak.pre-dotfiles already exists" >&2
                exit 1
            fi
            mv -n "$HOME/.local/bin/speak" "$HOME/.local/bin/speak.pre-dotfiles"
            notify "Moved the old speak wrapper to $HOME/.local/bin/speak.pre-dotfiles"
        fi
        ln -sf "${BASEDIR}/files/.local/bin/speak" "$HOME/.local/bin/speak"
        notify "Testing Piper with en_US-lessac-medium..."
        if ! SPEAK_VOICE=en_US-lessac-medium SPEAK_OUTPUT="$SMOKE_DIR/ready.wav" \
            "$HOME/.local/bin/speak" "The voice is ready." || [ ! -s "$SMOKE_DIR/ready.wav" ]; then
            printf '%s\n' 'Piper smoke test failed: speak did not produce a nonempty WAV' >&2
            exit 1
        fi
        notify "Voice for the chat skill is ready!"
        exit 0
        ;;
    Darwin) ;;
    *)
        printf 'Unsupported OS: %s\n' "$OS" >&2
        exit 1
        ;;
esac

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
if ! command -v uv > /dev/null 2>&1; then
    notify "Installing uv..."
    "$BREW" install uv
fi
UV=$(command -v uv)

SPACY_MODEL_WHEEL=https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
TOOL_DIR="$("$UV" tool dir)/mlx-audio"
TOOL_PYTHON="$TOOL_DIR/bin/python"

# Check uv's requested extras and wheel as well as the installed versions.
if [ -x "$HOME/.local/bin/mlx_audio.server" ] && [ -x "$TOOL_PYTHON" ] &&
    "$TOOL_PYTHON" - "$MLX_AUDIO_VERSION" "$SPACY_MODEL_WHEEL" "$TOOL_DIR/uv-receipt.toml" <<'PY'
import sys
import tomllib
from importlib.metadata import version

try:
    with open(sys.argv[3], "rb") as receipt:
        tool = tomllib.load(receipt)["tool"]
    expected = [
        {"name": "mlx-audio", "extras": ["server"], "specifier": "==" + sys.argv[1]},
        {"name": "misaki", "extras": ["en"]},
        {"name": "en-core-web-sm", "url": sys.argv[2]},
    ]
    assert sys.version_info[:2] == (3, 12)
    assert tool["python"] == "3.12" and tool["requirements"] == expected
    assert version("mlx-audio") == sys.argv[1]
    assert version("en-core-web-sm") == "3.8.0"
    for package in ("misaki", "spacy", "fastapi", "uvicorn", "python-multipart", "webrtcvad"):
        version(package)
except Exception:
    sys.exit(1)
PY
then
    notify "mlx-audio $MLX_AUDIO_VERSION and Kokoro extras already installed; skipping install"
else
    notify "Installing mlx-audio $MLX_AUDIO_VERSION and Kokoro extras on Python 3.12..."
    # The SDK symlink selects the compatible SDK; xcrun picks macOS 27 on this Mac.
    if [ -z "${SDKROOT:-}" ] && [ -d /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk ]; then
        SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
        export SDKROOT
    fi
    UV_TOOL_BIN_DIR="$HOME/.local/bin" "$UV" tool install --force --python 3.12 \
        "mlx-audio[server]==$MLX_AUDIO_VERSION" \
        --with 'misaki[en]' --with "en-core-web-sm @ $SPACY_MODEL_WHEEL"
fi

mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
ln -sf "${BASEDIR}/files/.local/bin/speak" "$HOME/.local/bin/speak"
PLIST="$HOME/Library/LaunchAgents/local.speak-server.plist"
cp "${BASEDIR}/files/Library/LaunchAgents/local.speak-server.plist" "$PLIST"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/local.speak-server" > /dev/null 2>&1 || :
# bootout can return before launchd finishes removing the old instance.
DEADLINE=$(($(date +%s) + 15))
while :; do
    if BOOTSTRAP_ERROR=$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1); then
        break
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        printf '%s\n' "$BOOTSTRAP_ERROR" >&2
        exit 1
    fi
    sleep 1
done

notify "Waiting up to 60 seconds for the local voice server..."
READY=0
DEADLINE=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if /usr/bin/curl --noproxy '*' --silent --fail --connect-timeout 1 --max-time 2 \
        http://127.0.0.1:7341/ > /dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 1
done
if [ "$READY" -ne 1 ]; then
    printf '%s\n' "Voice server did not start; see $HOME/Library/Logs/speak-server.log" >&2
    exit 1
fi

notify "Warming Kokoro-82M; the first run downloads the model..."
WARMUP_DIR=$(mktemp -d)
trap 'rm -rf "$WARMUP_DIR"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
STATUS=$(/usr/bin/curl --noproxy '*' --silent --show-error --connect-timeout 1 --max-time 600 \
    --header 'Content-Type: application/json' \
    --data '{"model":"mlx-community/Kokoro-82M-bf16","input":"The voice server is ready.","voice":"af_heart","lang_code":"a","speed":1.0,"response_format":"wav"}' \
    --output "$WARMUP_DIR/ready.wav" --write-out '%{http_code}' \
    http://127.0.0.1:7341/v1/audio/speech)
if [ "$STATUS" != 200 ] || [ ! -s "$WARMUP_DIR/ready.wav" ]; then
    printf 'Voice warm-up failed (HTTP %s); see %s/Library/Logs/speak-server.log\n' "$STATUS" "$HOME" >&2
    exit 1
fi
notify "Voice for the chat skill is ready!"
