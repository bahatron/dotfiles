#!/bin/sh
BASEDIR=$(dirname "$0")

notify() {
    echo "================================================ ${1}"
}

notify "Installing dependencies..."
sudo add-apt-repository ppa:linuxuprising/guake
curl -sL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt-get update
sudo apt-get install nodejs zsh curl git guake -y
notify "Dependencies installed!"
sleep 3

## zsh
notify "Installing ZSH..."
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
notify "ZSH installed!"
sleep 3

## docker
notify "Installing DOCKER..."
sudo apt-get install apt-transport-https ca-certificates curl gnupg-agent software-properties-common
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
sudo apt-key fingerprint 0EBFCD88
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io -y
sudo curl -L "https://github.com/docker/compose/releases/download/1.29.2/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
sudo groupadd docker
sudo usermod -aG docker $USER
notify "DOCKER installed!"
sleep 3

## tilt
notify "Installing TILT..."
curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash
notify "TILT installed!"

## CP config files
## TODO: use symlinks (ln -s) to keep files up to date
cp -rf ${BASEDIR:-.}/files/.p10k.zsh ~/.p10k.zsh
cp -rf ${BASEDIR:-.}/files/.bashrc ~/.bashrc
cp -rf ${BASEDIR:-.}/files/.zshrc ~/.zshrc
cp -rf ${BASEDIR:-.}/files/.bash_aliases ~/.bash_aliases