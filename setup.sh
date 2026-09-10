#!/bin/sh
BASEDIR=$(cd "$(dirname "$0")" && pwd)

notify() {
    echo "================================================ ${1}"
}

notify "Installing dependencies..."
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get update
sudo apt-get install zsh curl git guake htop nodejs -y
wget -q -O- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
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
## Headroom: local context-compression proxy for Claude Code + Codex.
## Runs as systemd user unit "headroom-default" on 127.0.0.1:8787. Both VS Code
## extensions read the same files it edits (~/.claude/settings.json, ~/.codex/config.toml).
notify "Installing Headroom..."
# uv with explicit dirs: VS Code's snap remaps XDG_DATA_HOME, which sends installers to ~/snap/code/<rev>/.
curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 sh
export PATH="$HOME/.local/bin:$PATH"
UV_TOOL_DIR="$HOME/.local/share/uv/tools" UV_TOOL_BIN_DIR="$HOME/.local/bin" \
UV_PYTHON_INSTALL_DIR="$HOME/.local/share/uv/python" UV_CACHE_DIR="$HOME/.cache/uv" \
  uv tool install --python 3.13 "headroom-ai[all]"
# --scope provider: env.ANTHROPIC_BASE_URL in settings.json + [model_providers.headroom] in config.toml.
# Targets are explicit because Codex is only bundled inside the VS Code extension (not on PATH).
env -u XDG_DATA_HOME headroom install apply --preset persistent-service --scope provider \
  --providers manual --target claude --target codex --port 8787
# The installer writes ENABLE_TOOL_SEARCH=true; the Claude VS Code webview cannot render
# tool-search blocks (headroom #2028), so keep it false. Undo everything: headroom install remove
python3 - <<'PYEOF'
import json, pathlib
p = pathlib.Path.home() / ".claude" / "settings.json"
d = json.loads(p.read_text())
d.setdefault("env", {})["ENABLE_TOOL_SEARCH"] = "false"
p.write_text(json.dumps(d, indent=2) + "\n")
PYEOF
headroom doctor || true
notify "Headroom installed! (reload the VS Code window to pick up the new routing)"
