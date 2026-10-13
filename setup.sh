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
        "$BREW" install --cask linearmouse
        # Karabiner-Elements gives Linux-style Ctrl shortcuts and Linux modifier order (decided 13-10-2026).
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

## Claude Code: symlink tracked config only; installation state stays local
mkdir -p ~/.claude
ln -sf "${BASEDIR}/files/.claude/CLAUDE.md" ~/.claude/CLAUDE.md
ln -sf "${BASEDIR}/files/.claude/settings.json" ~/.claude/settings.json
rm -rf ~/.claude/skills
ln -sf "${BASEDIR}/files/.claude/skills" ~/.claude/skills
mkdir -p ~/.claude/hooks
ln -sf "${BASEDIR}/files/.claude/hooks/cold-cache-guard.mjs" ~/.claude/hooks/cold-cache-guard.mjs
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

if [ "$OS" = Darwin ]; then
    notify "Keyboard: add the British - PC input source in System Settings > Keyboard > Input Sources (matches Linux gb)"
    notify "Mouse: open LinearMouse once and grant Accessibility access"
    notify "Keyboard: open Karabiner-Elements once, approve its permissions, and pick ISO if asked for the keyboard type"
fi
