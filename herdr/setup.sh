#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config_path=${HERDR_CONFIG_PATH:-"${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml"}
config_dir=$(dirname -- "$config_path")

mkdir -p "$config_dir"

if [[ -e "$config_path" ]] && ! cmp -s "$repo_dir/config.toml" "$config_path"; then
  backup_path="$config_path.bak.$(date +%Y%m%d-%H%M%S)"
  suffix=1
  while [[ -e "$backup_path" ]]; do
    backup_path="$config_path.bak.$(date +%Y%m%d-%H%M%S).$suffix"
    suffix=$((suffix + 1))
  done
  cp -p "$config_path" "$backup_path"
  printf 'Backed up existing Herdr config to %s\n' "$backup_path"
fi

install -m 0644 "$repo_dir/config.toml" "$config_path"
herdr plugin link "$repo_dir"
herdr plugin enable herdr-ops.pr
herdr server reload-config

printf 'Installed %s and reloaded Herdr.\n' "$config_path"
