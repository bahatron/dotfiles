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
        ;;
esac
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

## Claude Code: symlink tracked config only; installation state stays local
mkdir -p ~/.claude
ln -sf "${BASEDIR}/files/.claude/CLAUDE.md" ~/.claude/CLAUDE.md
ln -sf "${BASEDIR}/files/.claude/settings.json" ~/.claude/settings.json
rm -rf ~/.claude/skills
ln -sf "${BASEDIR}/files/.claude/skills" ~/.claude/skills
mkdir -p ~/.claude/hooks
ln -sf "${BASEDIR}/files/.claude/hooks/cold-cache-guard.mjs" ~/.claude/hooks/cold-cache-guard.mjs
ln -sf "${BASEDIR}/files/.claude/hooks/never-ask.mjs" ~/.claude/hooks/never-ask.mjs
