#!/bin/sh
BASEDIR=$(dirname "$0")

sudo add-apt-repository ppa:linuxuprising/guake
sudo apt-get update
sudo apt-get install zsh curl git guake -y


# sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
# git clone --depth=1 https://github.com/romkatv/powerlevel10k.git $ZSH_CUSTOM/themes/powerlevel10k

cp -rf $BASEDIR/zsh/oh-my-zsh ~/.oh-my-zsh
cp -rf $BASEDIR/zsh/.p10k.zsh ~/.p10k.zsh
cp -rf $BASEDIR/zsh/.zshrc ~/.zshrc
cat "" > ~/.bash_aliases