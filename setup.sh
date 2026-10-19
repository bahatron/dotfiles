#!/bin/sh
BASEDIR=$(cd "$(dirname "$0")" && pwd)

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

notify "Installing dependencies..."
case "$OS" in
    Linux)
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get update
        sudo apt-get install zsh curl git guake htop nodejs direnv -y
        ;;
    Darwin)
        if ! command -v brew > /dev/null 2>&1; then
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        if BREW=$(command -v brew) && [ -x "$BREW" ]; then
            :
        elif [ -x /opt/homebrew/bin/brew ]; then
            BREW=/opt/homebrew/bin/brew
        elif [ -x /usr/local/bin/brew ]; then
            BREW=/usr/local/bin/brew
        else
            printf '%s\n' "Homebrew executable not found after installation." >&2
            exit 1
        fi
        eval "$("$BREW" shellenv)"
        BREW_SHELLENV="eval \"\$($BREW shellenv)\""
        if [ ! -f "$HOME/.zprofile" ] || ! grep -Fqx "$BREW_SHELLENV" "$HOME/.zprofile"; then
            printf '\n%s\n' "$BREW_SHELLENV" >> "$HOME/.zprofile"
        fi
        "$BREW" install git htop node direnv
        "$BREW" install --cask iterm2
        # LinearMouse reverses the wheel for mice only; the trackpad keeps the macOS default (decided 13-10-2026).
        # LinearMouse also turns off pointer acceleration for mice only, a flat profile as on Linux (decided 17-10-2026).
        "$BREW" install --cask linearmouse
        # Karabiner-Elements gives Linux-style Ctrl shortcuts and Linux modifier order (decided 13-10-2026).
        # VS Code keeps its own Ctrl+R, F5 and Ctrl+G; it uses them as on Linux (decided 17-10-2026).
        # Super alone opens Mission Control and Super + the key above Tab cycles app windows, as in GNOME (decided 17-10-2026).
        # Alt + the key above Tab shows the app's windows (App Exposé) instead of cycling them (decided 17-10-2026).
        # Ctrl+Alt+T opens iTerm2 or brings it to the front, as on Ubuntu (decided 17-10-2026).
        # Print Screen starts an area capture (Command+Shift+4), not the screenshot toolbar (decided 19-10-2026).
        "$BREW" install --cask karabiner-elements
        ;;
esac

## Chrome for the Playwright MCP
notify "Checking Chrome for the Playwright MCP..."
case "$OS" in
    Linux)
        if ! command -v google-chrome > /dev/null 2>&1; then
            npx -y playwright install chrome
        fi
        ;;
    Darwin)
        if [ ! -d "/Applications/Google Chrome.app" ]; then
            npx -y playwright install chrome
        fi
        ;;
esac
notify "Chrome for the Playwright MCP checked!"
sleep 3

# The linked .zshrc and .bashrc load nvm; stop its installer adding a second loader (to ~/.zprofile on a Mac).
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | PROFILE=/dev/null bash
notify "Dependencies installed!"
sleep 3

## zsh
notify "Installing ZSH..."
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
notify "ZSH installed!"
sleep 3

## Docker
notify "Installing Docker..."
case "$OS" in
    Linux)
        sudo apt-get install -y ca-certificates
        sudo install -m 0755 -d /etc/apt/keyrings
        sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
        sudo chmod a+r /etc/apt/keyrings/docker.asc
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
        sudo apt-get update
        sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        sudo groupadd -f docker
        sudo usermod -aG docker "$USER"
        notify "Docker installed! (log out and back in for group changes to take effect)"
        ;;
    Darwin)
        # Docker Desktop, not Colima (decided 03-10-2026). Free for personal use and businesses under 250 staff
        # and $10M revenue; organisations above that need a paid seat.
        "$BREW" install --cask docker-desktop
        notify "Docker Desktop installed! Open Docker.app once to accept the license and finish setup"
        ;;
esac
sleep 3

## Symlink config files to keep them up to date
ln -sf "${BASEDIR}/files/.p10k.zsh" ~/.p10k.zsh
ln -sf "${BASEDIR}/files/.bashrc" ~/.bashrc
ln -sf "${BASEDIR}/files/.zshrc" ~/.zshrc
cp -rf ${BASEDIR:-.}/files/.bash_aliases ~/.bash_aliases

if [ "$OS" = Darwin ]; then
    mkdir -p ~/.config
    rm -rf ~/.config/linearmouse
    ln -sf "${BASEDIR}/files/.config/linearmouse" ~/.config/linearmouse
    # Karabiner watches this directory, so link the directory once and never recreate a correct link.
    if [ ! -L ~/.config/karabiner ] || [ "$(readlink ~/.config/karabiner)" != "${BASEDIR}/files/.config/karabiner" ]; then
        mkdir -p ~/.config
        rm -rf ~/.config/karabiner
        ln -s "${BASEDIR}/files/.config/karabiner" ~/.config/karabiner
    fi
fi

## Husky: load nvm for Git hooks launched by GUI clients
HUSKY_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/husky"
mkdir -p "$HUSKY_CONFIG_DIR"
ln -sf "${BASEDIR}/files/.config/husky/init.sh" "$HUSKY_CONFIG_DIR/init.sh"

## Claude Code: symlink tracked config only; installation state stays local
mkdir -p ~/.claude
ln -sf "${BASEDIR}/files/.claude/CLAUDE.md" ~/.claude/CLAUDE.md
ln -sf "${BASEDIR}/files/.claude/settings.json" ~/.claude/settings.json
rm -rf ~/.claude/skills
ln -sf "${BASEDIR}/files/.claude/skills" ~/.claude/skills
mkdir -p ~/.claude/hooks
rm -f ~/.claude/hooks/cold-cache-guard.mjs
ln -sf "${BASEDIR}/files/.claude/hooks/never-ask.mjs" ~/.claude/hooks/never-ask.mjs

## VS Code: code on the command line (macOS; Linux packages already provide it)
if [ "$OS" = Darwin ]; then
    CODE=
    for CANDIDATE in "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
        if [ -x "$CANDIDATE" ]; then
            CODE=$CANDIDATE
            break
        fi
    done
    if [ -n "$CODE" ]; then
        mkdir -p ~/.local/bin
        ln -sf "$CODE" ~/.local/bin/code
    else
        notify "VS Code not found: install it, then re-run setup.sh to get the code command"
    fi
fi

## Claude Code plugins and MCP servers
notify "Configuring Claude Code plugins and MCP servers..."
# User-scope MCP servers live inside ~/.claude.json (Claude's own state file), so the definition is tracked
# here and registered, not symlinked. The RTK plugin downloads its binary and writes RTK.md on first session.
if ! CLAUDE=$(command -v claude); then
    CLAUDE=
    for CANDIDATE in "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude; do
        if [ -x "$CANDIDATE" ]; then
            CLAUDE=$CANDIDATE
        fi
    done
fi
if [ -n "$CLAUDE" ]; then
    "$CLAUDE" plugin marketplace add enixCode/plugins
    "$CLAUDE" plugin install rtk-plugin@enix --scope user
    "$CLAUDE" mcp remove --scope user playwright > /dev/null 2>&1
    "$CLAUDE" mcp add-json --scope user playwright "$(cat "${BASEDIR}/files/.claude/mcp/playwright.json")"
    notify "Claude Code plugins and MCP servers configured!"
else
    notify "Claude Code not found: install it, then re-run setup.sh to add the RTK plugin and the Playwright MCP"
fi
sleep 3

## Power: keep the Mac awake while the display sleeps
# Disable idle system sleep on all power sources so background work keeps running (decided 16-10-2026).
if [ "$OS" = Darwin ]; then
    notify "Checking idle system sleep..."
    if pmset -g custom | awk '$1 == "sleep" && $2 != 0 { on = 1 } END { exit !on }'; then
        notify "Disabling idle system sleep on all power sources; sudo will ask for your password..."
        sudo pmset -a sleep 0
    fi
    notify "Idle system sleep checked!"
fi

## Voice for the chat skill
# Kokoro-82M on macOS, Piper on Linux for now; speak-setup.sh also runs alone (decided 17-10-2026).
"${BASEDIR}/speak-setup.sh"

## macOS approvals only a person can click; post-setup.sh also runs alone, without touching the dotfiles
if [ "$OS" = Darwin ]; then
    "${BASEDIR}/post-setup.sh"
fi
