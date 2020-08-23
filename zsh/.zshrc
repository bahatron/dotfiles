# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block, everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# Path to your oh-my-zsh installation.
export ZSH=~/.oh-my-zsh

# Set the theme
ZSH_THEME=powerlevel10k/powerlevel10k
POWERLEVEL9K_MODE="nerdfont-complete"
KEYTIMEOUT=1

# plugins
plugins=(git)

source $ZSH/oh-my-zsh.sh

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# The optional three formats: "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
export HIST_STAMPS="yyyy-mm-dd"
export HISTSIZE=999999999
export SAVEHIST=999999999

export LANG=en_US.UTF-8
export EDITOR=nvim
export GPG_TTY=$(tty)

# docker-compose
alias dcc="docker-compose"
alias dce="docker-compose exec"
alias dcr="docker-compose run"
alias dps="docker ps"
alias dprune="docker system prune -a -f"

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

setopt noautocd
source ~/.bash_aliases