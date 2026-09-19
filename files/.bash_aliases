# doker
alias dps="docker ps"
dstop() { if [ "$#" -eq 0 ]; then set -- $(docker ps -aq); else set -- $(docker ps -q --filter "name=^$1"); fi; [ "$#" -eq 0 ] || docker stop "$@"; }
alias dprune="docker system prune -a -f"
