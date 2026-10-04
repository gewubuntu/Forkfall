#!/bin/sh
# PostToolUse hook for mcp__github__create_pull_request: reminds Claude to review the new PR right away
# (see CLAUDE.md). Reads the hook input on stdin and prints the reminder as additional context.
MSG='Per CLAUDE.md, review its diff now, before anything else: confirm findings with evidence, fix them on the PR branch with tests, update the PR description, and report the verdict to the user. For UI changes, take the screenshots too; if the change touches what docs/GDD-v0.1.md describes, check the GDD was updated in the same PR.'
if ! command -v jq >/dev/null 2>&1; then
  # Without jq: the same reminder, just without the PR link.
  cat >/dev/null
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A pull request was just opened. %s"}}\n' "$MSG"
  exit 0
fi
jq -c --arg msg "$MSG" '
  (.tool_response | tostring | [scan("https://github\\.com/[^\"\\\\ ]+/pull/[0-9]+")] | first) as $url
  | {hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: (
      "A pull request was just opened" + (if $url then " (" + $url + ")" else "" end) + ". " + $msg
    )}}'
