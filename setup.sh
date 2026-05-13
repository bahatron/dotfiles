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