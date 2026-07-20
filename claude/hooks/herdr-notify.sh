#!/bin/sh
# macOS notification for Claude Code state changes inside herdr panes,
# titled "Ghostty / {space} / {tab} / {pane} / {agent}". Outside herdr
# panes (e.g. Warp, a plain terminal) a simpler fallback path notifies
# instead of staying silent.
# herdr's own notification text is not configurable (config.toml has no
# format option), so ui.toast delivery is "off" and this hook replaces it.
# Registered on the Stop and Notification hook events.

command -v terminal-notifier >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
msg=$(printf '%s' "$input" | jq -r '.message // empty')

if [ -n "$HERDR_PANE_ID" ]; then
  command -v herdr >/dev/null 2>&1 || exit 0

  title=$(herdr api snapshot 2>/dev/null | jq -r \
    --arg ws "$HERDR_WORKSPACE_ID" --arg tab "$HERDR_TAB_ID" --arg pane "$HERDR_PANE_ID" '
    .result.snapshot as $s |
    ([$s.workspaces[]? | select(.workspace_id == $ws)][0]) as $w |
    ([$s.tabs[]?       | select(.tab_id       == $tab)][0]) as $t |
    ([$s.panes[]?      | select(.pane_id      == $pane)][0]) as $p |
    # The user is already looking at this pane; a notification would be noise.
    if $s.focused_workspace_id == $ws and $s.focused_pane_id == $pane then "FOCUSED"
    else
      ["Ghostty",
       ($w.label // $ws),
       ($t.label // $tab),
       ($p.label // ($pane | split(":")[1])),
       ($p.agent // "agent")
      ] | join(" / ")
    end' 2>/dev/null)

  [ -n "$title" ] || exit 0
  [ "$title" = "FOCUSED" ] && exit 0

  case "$event" in
    Stop)
      # Show the tail of Claude's final reply instead of a fixed string.
      # tail -n keeps whole lines (tail -c could split a JSON line and
      # break the slurp); the final text is always near the end at Stop.
      transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
      body=""
      if [ -n "$transcript" ] && [ -f "$transcript" ]; then
        body=$(tail -n 100 "$transcript" 2>/dev/null | jq -rs '
          [ .[]
            | select(.type == "assistant" and ((.isSidechain // false) | not))
            | .message.content // []
            | map(select(.type == "text") | .text)
            | join(" ")
            | select(length > 0)
          ] | last // "" | gsub("\\s+"; " ") | .[0:120]' 2>/dev/null)
      fi
      body="${body:-完了しました}"
      ;;
    Notification) body="${msg:-要対応です}" ;;
    *) body="${msg:-$event}" ;;
  esac

  terminal-notifier \
    -group "herdr-notify-$HERDR_PANE_ID" \
    -title "$title" \
    -message "$body" \
    -activate com.mitchellh.ghostty >/dev/null 2>&1 || true
  exit 0
fi

# herdr can tell us whether a pane is focused; outside herdr there is no such
# signal, so only Notification (likely away from keyboard) fires here — Stop
# would ring on every turn even while the user is watching.
[ "$event" = "Notification" ] || exit 0

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
cwd="${cwd:-$PWD}"
base="${cwd##*/}"
notif_type=$(printf '%s' "$input" | jq -r '.notification_type // empty')

title="Claude Code / ${base:-?}"
[ -n "$notif_type" ] && title="$title ($notif_type)"
body="${msg:-要対応です}"

case "$TERM_PROGRAM" in
  WarpTerminal) activate_bundle="dev.warp.Warp-Stable" ;;
  *) activate_bundle="com.mitchellh.ghostty" ;;
esac

terminal-notifier \
  -group "herdr-notify-fallback-${base:-unknown}" \
  -title "$title" \
  -message "$body" \
  -activate "$activate_bundle" >/dev/null 2>&1 || true
exit 0
