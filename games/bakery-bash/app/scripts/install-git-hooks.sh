#!/usr/bin/env bash
# Installs a pre-push hook that runs the UI-rules audit so Rule #1
# (hide-budget) and Rule #3 (no chef specialty) can't regress on push.
#
# Run once from anywhere:
#   bash games/bakery-bash/app/scripts/install-git-hooks.sh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-push"

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Bakery Bash — UI rules pre-push guard. See app/scripts/audit-ui-rules.sh.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
AUDIT="$REPO_ROOT/games/bakery-bash/app/scripts/audit-ui-rules.sh"
if [ -x "$AUDIT" ]; then
  bash "$AUDIT"
fi
HOOK

chmod +x "$HOOK_PATH"
echo "Installed pre-push hook at $HOOK_PATH"
