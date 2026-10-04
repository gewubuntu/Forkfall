#!/bin/sh
# PostToolUse hook for mcp__github__create_pull_request: reminds Claude to review the new PR right away
# (see CLAUDE.md). Reads the hook input on stdin and prints the reminder as additional context.
jq -c '
  (.tool_response | tostring | [scan("https://github\\.com/[^\"\\\\ ]+/pull/[0-9]+")] | first) as $url
  | {hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: (
      "A pull request was just opened" + (if $url then " (" + $url + ")" else "" end)
      + ". Per CLAUDE.md, review its diff now, before anything else: confirm findings with evidence, fix them on"
      + " the PR branch with tests, update the PR description, and report the verdict to the user. For UI"
      + " changes, take the screenshots too; if the change touches what docs/GDD-v0.1.md describes, check the"
      + " GDD was updated in the same PR."
    )}}'
