#!/bin/bash
# Claude Code status line: model | effort | 5h/7d bars and resets | context | git | cache TTL | keepalive
input=$(cat)

IFS='|' read -r model effort five week ctx cwd cache_observed cache_warm cache_ttl cache_expiry cache_present session_id model_id week_reset ctx_remind five_reset <<EOF
$(echo "$input" | jq -r '[
  (.model.display_name // "?"),
  (.effort.level // "-"),
  (.rate_limits.five_hour.used_percentage // ""),
  (.rate_limits.seven_day.used_percentage // ""),
  (.context_window.used_percentage // ""),
  (.workspace.current_dir // .cwd // ""),
  (.prompt_cache.caching_observed // false),
  (.prompt_cache.warm // false),
  (.prompt_cache.ttl // ""),
  (.prompt_cache.expires_at // ""),
  ((.prompt_cache | type) == "object"),
  (.session_id // ""),
  (.model.id // .model.display_name // ""),
  (.rate_limits.seven_day.resets_at // ""),
  ((.context_window.used_percentage // 0) >= 35),
  (.rate_limits.five_hour.resets_at // "")
] | map(tostring) | join("|")')
EOF

cache_estimated=""
if [ -n "$session_id" ]; then
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/claude-statusline/prompt-cache"
  cache_key=$(printf '%s\n' "$session_id" "$model_id" | sha256sum)
  cache_file="$cache_dir/${cache_key%% *}.json"
  if [ "$cache_present" = "true" ]; then
    cache_data=$(printf '%s' "$input" | jq -c '.prompt_cache | {caching_observed, warm, ttl, expires_at}')
    if [ "$cache_data" != "$(cat "$cache_file" 2>/dev/null)" ]; then
      (
        umask 077
        mkdir -p "$cache_dir" || exit
        cache_tmp=$(mktemp "$cache_dir/.tmp.XXXXXX") || exit
        trap 'rm -f -- "$cache_tmp"' EXIT
        printf '%s\n' "$cache_data" > "$cache_tmp" && mv -f -- "$cache_tmp" "$cache_file"
      ) 2>/dev/null
    fi
  elif [ -r "$cache_file" ]; then
    if cache_saved=$(jq -er '[
      (.caching_observed // false), (.warm // false),
      (.ttl // ""), (.expires_at // "")
    ] | map(tostring) | join("|")' "$cache_file" 2>/dev/null); then
      IFS='|' read -r cache_observed cache_warm cache_ttl cache_expiry <<< "$cache_saved"
      cache_estimated="~"
    fi
  fi
fi

if [ -n "$session_id" ]; then
  jq -nc --arg id "$session_id" --arg observed "$cache_observed" --arg warm "$cache_warm" \
    --arg ttl "$cache_ttl" --arg expiry "$cache_expiry" '{session_id: $id, prompt_cache: {
      caching_observed: ($observed == "true"), warm: ($warm == "true"), ttl: $ttl,
      expires_at: (if $expiry == "" then null else ($expiry | tonumber) end)
    }}' | bash "$HOME/.claude/keepwarm/write-cache.sh" 2>/dev/null
fi

RST=$'\033[0m'
DIM=$'\033[2m'
GRN=$'\033[32m'
YEL=$'\033[33m'
RED=$'\033[31m'
CYN=$'\033[36m'
case "$effort" in
  low) effort_color=110 ;;
  medium) effort_color=115 ;;
  high) effort_color=146 ;;
  xhigh) effort_color=215 ;;
  max) effort_color=210 ;;
  *) effort_color=146 ;;
esac
printf -v EFFORT_STYLE '\033[1;38;5;%sm' "$effort_color"

color_for() {
  local p=$1
  if [ "$p" -ge 80 ]; then printf '%s' "$RED"
  elif [ "$p" -ge 50 ]; then printf '%s' "$YEL"
  else printf '%s' "$GRN"; fi
}

# bar <label> <pct> : 8-cell progress bar
bar() {
  local label=$1 raw=$2 width=8 p filled i color out=""
  if [ -z "$raw" ]; then
    printf '%s%s --%s' "$DIM" "$label" "$RST"
    return
  fi
  p=$(printf '%.0f' "$raw")
  [ "$p" -gt 100 ] && p=100
  [ "$p" -lt 0 ] && p=0
  if awk -v p="$raw" 'BEGIN {exit !(p > 85)}'; then color=$RED
  else color=$GRN; fi
  filled=$(( (p * width + 50) / 100 ))
  for ((i = 0; i < width; i++)); do
    if [ "$i" -lt "$filled" ]; then out="${out}█"; else out="${out}░"; fi
  done
  printf '%s %s%s%s %s%%' "$label" "$color" "$out" "$RST" "$p"
}

# context percentage
if [ -n "$ctx" ]; then
  cp=$(printf '%.0f' "$ctx")
  ctx_str="ctx $(color_for "$cp")${cp}%${RST}"
  [ "$ctx_remind" = "true" ] && ctx_str="${ctx_str} ${YEL}建议压缩${RST}"
else
  ctx_str="${DIM}ctx --${RST}"
fi

five_reset_str="--"
if [ -n "$five_reset" ]; then
  five_reset_str=$(TZ=Asia/Shanghai date -d "@$five_reset" '+%H:%M' 2>/dev/null) || five_reset_str="--"
fi
five_str="$(bar 5h "$five") ${DIM}${five_reset_str}${RST}"

week_reset_str="--"
if [ -n "$week_reset" ]; then
  week_reset_str=$(TZ=Asia/Shanghai date -d "@$week_reset" '+%-d日%H:%M' 2>/dev/null) || week_reset_str="--"
fi
week_str="$(bar 7d "$week") ${DIM}${week_reset_str}${RST}"

# git added/removed lines (tracked changes vs HEAD, no optional locks)
git_str=""
if [ -n "$cwd" ] && git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  read -r add del <<EOF
$(git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null | awk '$1 != "-" {a += $1; d += $2} END {print a + 0, d + 0}')
EOF
  git_str="${GRN}+${add:-0}${RST} ${RED}-${del:-0}${RST}"
fi

# Claude Code supplies the main conversation's cache expiry in epoch seconds.
cache_str="${DIM}cache --${RST}"
if [ "$cache_observed" = "true" ]; then
  cache_remaining=0
  if [ "$cache_warm" = "true" ] && [ -n "$cache_expiry" ]; then
    cache_remaining=$(( cache_expiry - $(date +%s) ))
  fi
  if [ "$cache_remaining" -gt 0 ]; then
    cache_total=300
    [ "$cache_ttl" = "1h" ] && cache_total=3600
    printf -v cache_countdown '%d:%02d' "$(( cache_remaining / 60 ))" "$(( cache_remaining % 60 ))"
    cache_used=$(( 100 - cache_remaining * 100 / cache_total ))
    cache_str="cache $(color_for "$cache_used")${cache_estimated}${cache_countdown}${RST}"
  else
    cache_str="${RED}cache 已过期${RST}"
  fi
fi

keepalive_status() (
  local file="$HOME/.claude/keepwarm/sessions/$session_id.json"
  local saved state cold next bumps max_bumps schedule margin remaining
  if [ -z "$session_id" ] || ! saved=$(jq -er '[.state, .cold, (.nextBumpAt // ""), .bumps, .maxBumps, (.schedule // "idle"), ((.cacheMarginMinutes // 0) * 60 | floor)] | map(tostring) | join("|")' "$file" 2>/dev/null); then
    printf '%s保活 未运行%s' "$DIM" "$RST"
    return
  fi
  IFS='|' read -r state cold next bumps max_bumps schedule margin <<< "$saved"
  if [ "$state" = "paused" ]; then
    printf '%s保活 暂停%s' "$YEL" "$RST"
    return
  fi
  if [ "$state" = "stopped" ]; then
    printf '%s保活 关%s' "$DIM" "$RST"
    return
  fi
  if [ "$state" != "active" ]; then
    printf '%s保活 未运行%s' "$DIM" "$RST"
    return
  fi
  if [ "$cold" = "true" ]; then
    printf '%s保活 等待对话%s' "$YEL" "$RST"
    return
  fi
  if [ "$schedule" = "cache-expiry" ]; then
    if [ "$cache_observed" != "true" ] || [ "$cache_warm" != "true" ] || [ -z "$cache_expiry" ]; then
      printf '%s保活 等待缓存%s' "$DIM" "$RST"
      return
    fi
    if [ "$cache_expiry" -le "$(date +%s)" ]; then
      printf '%s保活 等待对话%s' "$YEL" "$RST"
      return
    fi
    next=$((cache_expiry - margin))
  fi
  remaining=$((next - $(date +%s)))
  if [ "$remaining" -gt 0 ]; then
    printf '%s保活 开%s ~%d:%02d %s/%s' "$GRN" "$RST" "$((remaining / 60))" "$((remaining % 60))" "$bumps" "$max_bumps"
  else
    printf '%s保活 开%s 等待轮询 %s/%s' "$GRN" "$RST" "$bumps" "$max_bumps"
  fi
)

sep=" ${DIM}|${RST} "
parts=("${CYN}${model}${RST}" "${EFFORT_STYLE}${effort}${RST}" "$five_str" "$week_str" "$ctx_str")
[ -n "$git_str" ] && parts+=("$git_str")
parts+=("$cache_str" "$(keepalive_status)")

# COLUMNS is supplied by Claude Code; reserve four cells for its footer spacing.
/usr/bin/python3 - "${COLUMNS:-80}" "$sep" "${parts[@]}" <<'PY'
import re
import sys
import unicodedata

limit = max(2, int(sys.argv[1]) - 4)
separator = sys.argv[2]
ansi = re.compile(r"\x1b\[[0-9;]*m")
tokens = re.compile(r"\x1b\[[0-9;]*m|.")
reset = "\x1b[0m"

def cell_width(char):
    if unicodedata.category(char) in {"Mn", "Me", "Cf"}:
        return 0
    return 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1

def visible_width(text):
    return sum(cell_width(char) for char in ansi.sub("", text))

rows = []
line = ""
used = 0
style = ""
for part in sys.argv[3:]:
    if used:
        if used + visible_width(separator) + visible_width(part) <= limit:
            line += separator
            used += visible_width(separator)
        else:
            rows.append(line + reset)
            line, used = style, 0
    for token in tokens.findall(part):
        if ansi.fullmatch(token):
            line += token
            style = "" if token == reset else style + token
            continue
        cells = cell_width(token)
        if used + cells > limit:
            rows.append(line + reset)
            line, used = style, 0
        line += token
        used += cells
sys.stdout.write("\n".join(rows + [line]))
PY
