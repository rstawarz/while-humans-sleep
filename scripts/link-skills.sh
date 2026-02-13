#!/usr/bin/env bash
# Link WHS skills into ~/.claude/skills/ so Claude Code can discover them.
#
# Usage:
#   ./scripts/link-skills.sh          # link all skills
#   npm run setup:skills              # same, via npm

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$REPO_DIR/skills"
TARGET_DIR="$HOME/.claude/skills"

mkdir -p "$TARGET_DIR"

linked=0
for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name="$(basename "$skill_dir")"

  if [[ ! -f "$skill_dir/SKILL.md" ]]; then
    echo "  skip  $skill_name (no SKILL.md)"
    continue
  fi

  target="$TARGET_DIR/$skill_name"
  # Remove existing symlink or warn about non-symlink conflicts
  if [[ -L "$target" ]]; then
    rm "$target"
  elif [[ -e "$target" ]]; then
    echo "  WARN  $target exists and is not a symlink — skipping"
    continue
  fi

  ln -s "$skill_dir" "$target"
  echo "  link  $skill_name -> $skill_dir"
  linked=$((linked + 1))
done

echo ""
echo "Linked $linked skill(s) into $TARGET_DIR"
