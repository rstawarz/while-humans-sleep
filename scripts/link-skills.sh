#!/usr/bin/env bash
# Link WHS skills and agents into ~/.claude/ so Claude Code can discover them.
#
# Usage:
#   ./scripts/link-skills.sh          # link all skills + agents
#   npm run setup:skills              # same, via npm

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- Skills ---
SKILLS_DIR="$REPO_DIR/skills"
SKILLS_TARGET="$HOME/.claude/skills"
mkdir -p "$SKILLS_TARGET"

skills_linked=0
for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name="$(basename "$skill_dir")"

  if [[ ! -f "$skill_dir/SKILL.md" ]]; then
    echo "  skip  skill/$skill_name (no SKILL.md)"
    continue
  fi

  target="$SKILLS_TARGET/$skill_name"
  if [[ -L "$target" ]]; then
    rm "$target"
  elif [[ -e "$target" ]]; then
    echo "  WARN  $target exists and is not a symlink — skipping"
    continue
  fi

  ln -s "$skill_dir" "$target"
  echo "  link  skill/$skill_name"
  skills_linked=$((skills_linked + 1))
done

# --- Agents ---
AGENTS_DIR="$REPO_DIR/docs/llm/agents"
AGENTS_TARGET="$HOME/.claude/agents"
mkdir -p "$AGENTS_TARGET"

agents_linked=0
for agent_file in "$AGENTS_DIR"/whs-plan-*.md; do
  [[ -f "$agent_file" ]] || continue
  agent_name="$(basename "$agent_file")"

  target="$AGENTS_TARGET/$agent_name"
  if [[ -L "$target" ]]; then
    rm "$target"
  elif [[ -e "$target" ]]; then
    echo "  WARN  $target exists and is not a symlink — skipping"
    continue
  fi

  ln -s "$agent_file" "$target"
  echo "  link  agent/$agent_name"
  agents_linked=$((agents_linked + 1))
done

echo ""
echo "Linked $skills_linked skill(s) into $SKILLS_TARGET"
echo "Linked $agents_linked agent(s) into $AGENTS_TARGET"
