#!/bin/sh
# Finishes macOS steps setup.sh cannot do alone: approvals only a person can click.
# Safe to re-run any time; never touches the dotfiles setup.sh links or copies.
# Kept apart to re-run without overwriting ~/.bash_aliases (decided 17-10-2026).
BASEDIR=$(cd "$(dirname "$0")" && pwd)

notify() {
    echo "================================================ ${1}"
}

CHECK_ONLY=0
if [ "$#" -eq 1 ] && [ "$1" = --check ]; then
    CHECK_ONLY=1
elif [ "$#" -ne 0 ]; then
    printf '%s\n' 'Usage: post-setup.sh [--check]' >&2
    exit 2
fi

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
    notify "Nothing to do on Linux: post-setup.sh only covers macOS approvals"
    exit 0
fi

if [ "$CHECK_ONLY" -eq 0 ]; then
    notify "Checking macOS approvals and opening System Settings where a switch is needed"
fi

KARABINER_DIR="/Library/Application Support/org.pqrs/Karabiner-Elements"
CORE_SERVICE_APP="$KARABINER_DIR/Karabiner-Core-Service.app"
DRIVER_MANAGER="/Applications/.Karabiner-VirtualHIDDevice-Manager.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Manager"
DRIVER_ID=org.pqrs.Karabiner-DriverKit-VirtualHIDDevice
LOGIN_ITEMS_PANE="x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
ACCESSIBILITY_PANE="x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
INPUT_MONITORING_PANE="x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
KEYBOARD_PANE="x-apple.systempreferences:com.apple.Keyboard-Settings.extension"
WAIT_SECONDS=${WAIT_SECONDS:-300}

# Helper app names are versioned, so find them by glob; the last match wins.
DAEMONS_APP=
for CANDIDATE in "$KARABINER_DIR"/"Karabiner-Elements Privileged Daemons v"*.app; do
    if [ -d "$CANDIDATE" ]; then
        DAEMONS_APP=$CANDIDATE
    fi
done
AGENTS_APP=
for CANDIDATE in "$KARABINER_DIR"/"Karabiner-Elements Non-Privileged Agents v"*.app; do
    if [ -d "$CANDIDATE" ]; then
        AGENTS_APP=$CANDIDATE
    fi
done
DAEMONS_NAME=$(basename "$DAEMONS_APP" .app)
DAEMONS_BIN="$DAEMONS_APP/Contents/MacOS/$DAEMONS_NAME"
AGENTS_NAME=$(basename "$AGENTS_APP" .app)
AGENTS_BIN="$AGENTS_APP/Contents/MacOS/$AGENTS_NAME"

RESULT_DIR=$(mktemp -d) || exit 1
RESULT_FILE="$RESULT_DIR/permissions.json"
trap 'rm -rf "$RESULT_DIR"' 0
trap 'exit 130' INT
trap 'exit 143' TERM

SUMMARY=
ALL_OK=1

record_result() {
    if [ "$1" != ok ]; then
        ALL_OK=0
    fi
    RESULT_LABEL=$2
    if [ -n "${3:-}" ]; then
        RESULT_LABEL="$RESULT_LABEL ($3)"
    fi
    SUMMARY="${SUMMARY}$(printf '    %-8s %s' "$1" "$RESULT_LABEL")
"
}

wait_until() {
    WAIT_LIMIT=$1
    shift
    printf 'Waiting up to %s s; press Ctrl-C to stop\n' "$WAIT_LIMIT"
    WAIT_DEADLINE=$(($(date +%s) + WAIT_LIMIT))
    while :; do
        if "$@"; then
            return 0
        fi
        if [ "$(date +%s)" -ge "$WAIT_DEADLINE" ]; then
            return 1
        fi
        sleep 2
        if [ "$(date +%s)" -ge "$WAIT_DEADLINE" ]; then
            return 1
        fi
    done
}

open_pane() {
    if [ "$CHECK_ONLY" -eq 0 ] && [ -n "$1" ]; then
        open "$1" > /dev/null 2>&1
    fi
}

check_item() {
    ITEM_NAME=$1
    ITEM_WAIT=$2
    ITEM_CHECK=$3
    ITEM_TRIGGER=$4
    ITEM_PANE=$5
    ITEM_MESSAGE=$6
    ITEM_FAILURE=${7:-}
    if "$ITEM_CHECK"; then
        record_result ok "$ITEM_NAME"
        return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
        record_result missing "$ITEM_NAME" "$ITEM_FAILURE"
        return
    fi
    "$ITEM_TRIGGER"
    open_pane "$ITEM_PANE"
    if [ -n "$ITEM_MESSAGE" ]; then
        printf '%s\n' "$ITEM_MESSAGE"
    fi
    if wait_until "$ITEM_WAIT" "$ITEM_CHECK"; then
        record_result ok "$ITEM_NAME"
    else
        printf '%s: still missing; approve it, then re-run post-setup.sh\n' "$ITEM_NAME"
        if [ -n "$ITEM_FAILURE" ]; then
            printf '%s\n' "$ITEM_FAILURE"
        fi
        record_result missing "$ITEM_NAME" "$ITEM_FAILURE"
    fi
}

background_services_ok() {
    "$AGENTS_BIN" core-agents-enabled > /dev/null 2>&1 &&
        "$DAEMONS_BIN" core-daemons-enabled > /dev/null 2>&1
}

register_background_services() {
    if ! "$AGENTS_BIN" core-agents-enabled > /dev/null 2>&1; then
        "$AGENTS_BIN" register-core-agents > /dev/null 2>&1
    fi
    if ! "$DAEMONS_BIN" core-daemons-enabled > /dev/null 2>&1; then
        "$DAEMONS_BIN" register-core-daemons > /dev/null 2>&1
    fi
}

driver_ok() {
    systemextensionsctl list 2> /dev/null |
        grep -F "$DRIVER_ID" | grep -Fq '[activated enabled]'
}

activate_driver() {
    if ! pgrep -f Karabiner-VirtualHIDDevice-Manager > /dev/null 2>&1; then
        "$DRIVER_MANAGER" activate > /dev/null 2>&1 &
    fi
}

permission_ok() {
    rm -f "$RESULT_FILE" "$RESULT_FILE.tmp"
    # Use LaunchServices so macOS attributes the check to Karabiner-Core-Service.
    open -n -g -a "$CORE_SERVICE_APP" --args permission-check "$RESULT_FILE" > /dev/null 2>&1 || return 1
    PERMISSION_POLLS=0
    while [ ! -f "$RESULT_FILE" ] && [ "$PERMISSION_POLLS" -lt 25 ]; do
        sleep 0.2
        PERMISSION_POLLS=$((PERMISSION_POLLS + 1))
    done
    if [ ! -f "$RESULT_FILE" ]; then
        return 1
    fi
    tr -d '[:space:]' < "$RESULT_FILE" | grep -Fq "\"$1\":true"
}

accessibility_ok() {
    permission_ok accessibility_process_trusted
}

input_monitoring_ok() {
    permission_ok iohid_listen_event_allowed
}

services_running() {
    "$DAEMONS_BIN" running > /dev/null 2>&1 &&
        "$AGENTS_BIN" running > /dev/null 2>&1
}

british_pc_ok() {
    defaults read com.apple.HIToolbox AppleEnabledInputSources 2> /dev/null | grep -Fq British-PC
}

linearmouse_running() {
    pgrep -x LinearMouse > /dev/null 2>&1
}

start_linearmouse() {
    open -a LinearMouse > /dev/null 2>&1
}

handy_running() {
    pgrep -x handy > /dev/null 2>&1
}

start_handy() {
    open -a Handy > /dev/null 2>&1
}

if [ -d /Applications/Karabiner-Elements.app ] &&
    [ -d "$DAEMONS_APP" ] && [ -d "$AGENTS_APP" ] && [ -d "$CORE_SERVICE_APP" ]; then
    record_result ok "Karabiner installed"

    if [ "$(readlink "$HOME/.config/karabiner")" = "$BASEDIR/files/.config/karabiner" ]; then
        record_result ok "Karabiner config link"
    else
        record_result missing "Karabiner config link" "re-run the Karabiner link step from setup.sh"
    fi

    check_item "Karabiner background services" "$WAIT_SECONDS" background_services_ok \
        register_background_services "$LOGIN_ITEMS_PANE" \
        "In Login Items & Extensions, switch on '$AGENTS_NAME' and '$DAEMONS_NAME'"

    check_item "Karabiner driver" "$WAIT_SECONDS" driver_ok activate_driver "$LOGIN_ITEMS_PANE" \
        "In Login Items & Extensions, under Extensions, open Driver Extensions (i) and switch on .Karabiner-VirtualHIDDevice-Manager (asks for your password)"

    check_item "Karabiner-Core-Service Accessibility" "$WAIT_SECONDS" accessibility_ok : "$ACCESSIBILITY_PANE" \
        "In Privacy & Security > Accessibility, switch on Karabiner-Core-Service. Not listed? Click +, press Cmd+Shift+G and add $CORE_SERVICE_APP"

    # Karabiner asks for Input Monitoring only after Accessibility is granted.
    check_item "Karabiner-Core-Service Input Monitoring" "$WAIT_SECONDS" input_monitoring_ok : "$INPUT_MONITORING_PANE" \
        "In Privacy & Security > Input Monitoring, switch on Karabiner-Core-Service. Not listed? Click +, press Cmd+Shift+G and add $CORE_SERVICE_APP"

    if [ "$ALL_OK" -eq 1 ]; then
        check_item "Karabiner services running" 60 services_running : "" "" \
            "Karabiner services are enabled but not running: in Login Items & Extensions switch both Karabiner items off and on again"
    elif services_running; then
        record_result ok "Karabiner services running"
    else
        record_result missing "Karabiner services running" "needs the approvals above"
    fi
else
    record_result missing "Karabiner installed" "run setup.sh first"
    for ITEM in "Karabiner config link" "Karabiner background services" "Karabiner driver" \
        "Karabiner-Core-Service Accessibility" "Karabiner-Core-Service Input Monitoring" "Karabiner services running"; do
        record_result missing "$ITEM" "Karabiner is not installed"
    done
fi
KARABINER_OK=$ALL_OK

check_item "British - PC input source" "$WAIT_SECONDS" british_pc_ok : "$KEYBOARD_PANE" \
    "In Keyboard > Text Input > Input Sources > Edit, click + and add English > British - PC (matches Linux gb)"

if [ -d /Applications/LinearMouse.app ]; then
    check_item "LinearMouse running" 30 linearmouse_running start_linearmouse "" ""
else
    record_result missing "LinearMouse running" "run setup.sh first"
fi

if [ -d /Applications/Handy.app ]; then
    check_item "Handy running" 30 handy_running start_handy "" ""
else
    record_result missing "Handy running" "run setup.sh first"
fi

notify "Mouse: grant LinearMouse Accessibility if it asks (Privacy & Security > Accessibility)"
notify "Dictation: in Handy's first-run steps pick Canary 180M Flash under Compatible Models (already downloaded), grant Microphone and Accessibility, and switch on Settings > Advanced > Launch on Startup; Option+Space (Alt+Space) dictates"
# Charge Limit stays manual because macOS has no command-line setter (decided 16-10-2026).
notify "Battery: set Charge Limit to 80% in System Settings > Battery > (i) next to Charging"

notify "Summary"
printf '%s' "$SUMMARY"
if [ "$KARABINER_OK" -eq 1 ]; then
    notify "Keyboard: test Ctrl+C and Ctrl+V in any text field"
fi

if [ "$ALL_OK" -eq 1 ]; then
    exit 0
fi
if [ "$CHECK_ONLY" -eq 1 ]; then
    notify "Run post-setup.sh without --check to walk through the missing items"
fi
exit 1
