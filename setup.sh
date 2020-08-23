#!/bin/sh
BASEDIR=$(dirname "$0")

sudo add-apt-repository ppa:linuxuprising/guake
curl -sL https://deb.nodesource.com/setup_14.x | sudo -E bash -
sudo apt-get update
sudo apt-get install nodejs zsh curl git guake -y

# install zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k

# config zsh
echo "" > ~/.bash_aliases

# with CP
mkdir ~/.config/Code && mkdir ~/.config/Code/User
cp -f ${BASEDIR}/vscode/* ~/.config/Code/User

cp -rf ${BASEDIR}/zsh/oh-my-zsh ~/.oh-my-zsh
cp -rf ${BASEDIR}/zsh/.p10k.zsh ~/.p10k.zsh
cp -rf ${BASEDIR}/zsh/.zshrc ~/.zshrc


#TODO: with LN