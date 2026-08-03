## Files and Commands

- For a specific tool, CLI, agent, or config, inspect its conventional directories before broad Home-directory searches.
- For Pi, Claude Code, Cursor, Codex CLI, opencode, Gemini CLI, or CodeGraph, initially limit searches to `~/.pi/`, `~/.agents/`, `~/.claude/`, `~/.cursor/`, `~/.codex/`, `~/.config/opencode/`, `~/.gemini/`, and the current project.
- Use `command -v` or `which` to find executables. For configs, use explicit target directories and bounded search depth.
- Without explicit approval, do not run broad scans such as `find ~`, `find /`, `rg ... ~`, or `grep -R ... ~`. Ask when the target directory is unclear.
- Read existing configs before editing and preserve their settings. Use only the scope and privileges required for the task.
- Never print complete API keys, tokens, passwords, or other sensitive credentials.
- After using tools, briefly list the paths inspected or changed.

## Execution Default

- Unless the user explicitly asks to implement or execute, do not modify files or run operational commands by default.
- If requirements are unclear, ask focused questions first.
- If requirements are sufficiently clear but direct execution was not requested, present a plan and wait for confirmation.

## Git

- Separate commits by functional purpose; do not mix unrelated changes.
- Use Chinese commit messages that accurately summarize the committed changes.
