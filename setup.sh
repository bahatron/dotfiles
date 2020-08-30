#!/bin/sh
BASEDIR=$(dirname "$0")

sudo add-apt-repository ppa:linuxuprising/guake
curl -sL https://deb.nodesource.com/setup_14.x | sudo -E bash -
sudo apt-get update
sudo apt-get install nodejs zsh curl git guake -y

## init aliases
if [ -f ~/.bash_aliases ]; then
    echo "aliases already initialised"
else
    echo "" > ~/.bash_aliases
fi

## zsh
echo "================================================ Installing ZSH..."
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
echo "================================================ ZSH installed!"

## docker
echo "================================================ Installing DOCKER..."
sudo apt-get install apt-transport-https ca-certificates curl gnupg-agent software-properties-common
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
sudo apt-key fingerprint 0EBFCD88
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io -y
sudo curl -L "https://github.com/docker/compose/releases/download/1.26.2/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
sudo groupadd docker
sudo usermod -aG docker $USER
echo "================================================ DOCKER installed!"

## tilt
echo "================================================ Installing Tilt..."
curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash
echo "================================================ Tilt installed!"

## CP config files
## TODO: use ln -s
cp -rf ${BASEDIR:-.}/zsh/.p10k.zsh ~/.p10k.zsh
cp -rf ${BASEDIR:-.}/zsh/.bashrc ~/.bashrc
cp -rf ${BASEDIR:-.}/zsh/.zshrc ~/.zshrc

mkdir ~/.config/Code && mkdir ~/.config/Code/User
cp -rf ${BASEDIR:-.}/vscode/* ~/.config/Code/User