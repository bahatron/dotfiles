# Load nvm for Git hooks started by GUI clients such as GitKraken.
# The nvm installer also supports XDG_CONFIG_HOME when NVM_DIR is unset.
if [ -z "${NVM_DIR:-}" ] && [ -n "${XDG_CONFIG_HOME:-}" ] &&
   [ -s "$XDG_CONFIG_HOME/nvm/nvm.sh" ]; then
  NVM_DIR="$XDG_CONFIG_HOME/nvm"
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  if [ -f .nvmrc ]; then
    nvm use --silent || exit $?
  fi
fi
