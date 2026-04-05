#!/bin/sh
BASEDIR=$(dirname "$0")

notify() {
    echo "================================================ ${1}"
}

notify "Installing dependencies..."
# curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get update
sudo apt-get install zsh curl git guake htop -y # nodejs
wget -q -O- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
notify "Dependencies installed!"
sleep 3

## zsh
notify "Installing ZSH..."
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
notify "ZSH installed!"
sleep 3

## Symlink config files to keep them up to date
ln -sf ${BASEDIR:-.}/files/.p10k.zsh ~/.p10k.zsh
ln -sf ${BASEDIR:-.}/files/.bashrc ~/.bashrc
ln -sf ${BASEDIR:-.}/files/.zshrc ~/.zshrc
cp -rf ${BASEDIR:-.}/files/.bash_aliases ~/.bash_aliases