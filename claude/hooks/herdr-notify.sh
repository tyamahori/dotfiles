#!/bin/sh
# macOS notification for Claude Code state changes inside herdr panes,
# titled "Ghostty / {space} / {tab} / {pane} / {agent}".
# herdr's own notification text is not configurable (config.toml has no
# format option), so ui.toast delivery is "off" and this hook replaces it.
# Registered on the Stop and Notification hook events.

[ -n "$HERDR_PANE_ID" ] || exit 0
command -v terminal-notifier >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v herdr >/dev/null 2>&1 || exit 0

input=$(cat)
event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
msg=$(printf '%s' "$input" | jq -r '.message // empty')

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
  Stop) body="完了しました" ;;
  Notification) body="${msg:-要対応です}" ;;
  *) body="${msg:-$event}" ;;
esac

terminal-notifier \
  -group "herdr-notify-$HERDR_PANE_ID" \
  -title "$title" \
  -message "$body" \
  -activate com.mitchellh.ghostty >/dev/null 2>&1 || true
exit 0
