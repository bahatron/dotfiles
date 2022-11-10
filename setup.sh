#!/bin/sh
BASEDIR=$(dirname "$0")

notify() {
    echo "================================================ ${1}"
}

notify "Installing dependencies..."
curl -sL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt-get update
sudo apt-get install nodejs zsh curl git guake htop -y
notify "Dependencies installed!"
sleep 3

## zsh
notify "Installing ZSH..."
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
notify "ZSH installed!"
sleep 3

## CP config files
## TODO: use symlinks (ln -s) to keep files up to date
cp -rf ${BASEDIR:-.}/files/.p10k.zsh ~/.p10k.zsh
cp -rf ${BASEDIR:-.}/files/.bashrc ~/.bashrc
cp -rf ${BASEDIR:-.}/files/.zshrc ~/.zshrc
cp -rf ${BASEDIR:-.}/files/.bash_aliases ~/.bash_aliases