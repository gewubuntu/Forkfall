#!/bin/sh
# Load the repo-root .env (if present) into the environment, then run the given command.
# Variables already set in the shell win over .env.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    val=${val%%\ \#*}                       # strip trailing " # comment"
    val=$(printf '%s' "$val" | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
    eval "isset=\${$key+x}"
    [ -z "$isset" ] && [ -n "$val" ] && export "$key=$val"
  done < "$ROOT/.env"
fi
exec "$@"
