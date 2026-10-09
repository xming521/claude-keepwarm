#!/bin/bash
set -e
input=$(cat)
id=$(printf '%s' "$input" | jq -er '.session_id // empty')
cache=$(printf '%s' "$input" | jq -c '.prompt_cache | {caching_observed, warm, ttl, expires_at}')
dir="$HOME/.claude/keepwarm/cache"
file="$dir/$id.json"
[ "$cache" != "$(cat "$file" 2>/dev/null)" ] || exit 0
umask 077
mkdir -p "$dir"
tmp=$(mktemp "$dir/.tmp.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
printf '%s\n' "$cache" > "$tmp"
mv -f -- "$tmp" "$file"
