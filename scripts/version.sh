#!/usr/bin/env bash
# The one version of GYM: backend, frontend and critics always carry the same
# semantic version, and the merge that releases it is tagged v<version>.
#
#   scripts/version.sh                 print the version, fail if the parts disagree
#   scripts/version.sh check v0.8.0    also fail unless it is this one (a tag)
#   scripts/version.sh set 0.9.0       write it into every part
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(backend/package.json frontend/package.json critics/pyproject.toml critics/lerobot_critics/__init__.py)
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

read_version() {
  case "$1" in
    *.json) sed -nE 's/^  "version": "([^"]*)",?$/\1/p' "$1" | head -1 ;;
    *.toml) sed -nE 's/^version = "([^"]*)"$/\1/p' "$1" | head -1 ;;
    *.py) sed -nE 's/^__version__ = "([^"]*)"$/\1/p' "$1" | head -1 ;;
  esac
}

write_version() {
  case "$1" in
    *.json) sed -i -E "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$2\"/" "$1" ;;
    *.toml) sed -i -E "0,/^version = \"[^\"]*\"$/s//version = \"$2\"/" "$1" ;;
    *.py) sed -i -E "s/^__version__ = \"[^\"]*\"$/__version__ = \"$2\"/" "$1" ;;
  esac
}

check() {
  local expected="${1#v}" first="" bad=0
  for f in "${FILES[@]}"; do
    local v
    v="$(read_version "$f")"
    if [[ ! "$v" =~ $SEMVER ]]; then
      echo "$f: no semantic version found (got \"$v\")" >&2
      bad=1
      continue
    fi
    first="${first:-$v}"
    if [[ "$v" != "$first" ]]; then
      echo "$f: $v, but ${FILES[0]} says $first" >&2
      bad=1
    fi
  done
  if [[ -n "$expected" && "$first" != "$expected" ]]; then
    echo "the parts say $first, expected $expected" >&2
    bad=1
  fi
  [[ $bad == 0 ]] || exit 1
  echo "$first"
}

case "${1:-check}" in
  check) check "${2:-}" ;;
  set)
    new="${2:-}"
    [[ "$new" =~ $SEMVER ]] || { echo "usage: $0 set <major.minor.patch>" >&2; exit 2; }
    for f in "${FILES[@]}"; do write_version "$f" "$new"; done
    check "$new"
    ;;
  *) echo "usage: $0 [check [vX.Y.Z] | set X.Y.Z]" >&2; exit 2 ;;
esac
