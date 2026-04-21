#!/usr/bin/env bash
# FE-01 — Hide-budget audit + ChefCard no-specialty regression guard.
#
# Enforces two "Hard UI Rules" from games/bakery-bash/FRONTEND.md:
#   #1 Budget is hidden during play — except for a small allowlist.
#   #3 Chef specialty is never rendered — ChefCard must not reference
#      `specialty` / `specialties` anywhere its output reaches the DOM.
#
# Run manually:     bash app/scripts/audit-ui-rules.sh
# Exit code:        0 when clean, 1 when any violation is found.
#
# Wire into CI / a pre-push hook to keep these rules from regressing.

set -euo pipefail

# cd to app/ so all paths below are relative to the React project root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
RESET="\033[0m"

fail=0

# ---------------------------------------------------------------------------
# Rule #1 — Hide budget during play.
# ---------------------------------------------------------------------------
# Files explicitly allowed to reference budgetCurrent / budgetRemaining.
# Keep in sync with FRONTEND.md "Hide-Budget Audit" allowlist.
BUDGET_ALLOWLIST=(
  "src/pages/ConclusionPage.tsx"
  "src/pages/ProfessorPage.tsx"
  "src/pages/ProfessorLeaderboardPage.tsx"
  "src/components/game/BudgetSummary.tsx"
  "src/pages/GamePage.tsx"
  "src/contexts/GameContext.tsx"
  "src/lib/cost.ts"
)

# Build a grep exclude-file list.
budget_excludes=()
for f in "${BUDGET_ALLOWLIST[@]}"; do
  budget_excludes+=(":(exclude)$f")
done

echo "==> Hide-budget audit (Rule #1)"
# Scope to src/pages and src/components; search for budget identifiers.
budget_hits=$(git grep -n -E 'budgetCurrent|budgetRemaining|remaining\s*cash|remaining\s*budget' \
  -- src/pages src/components "${budget_excludes[@]}" 2>/dev/null || true)
if [ -n "$budget_hits" ]; then
  echo -e "${RED}FAIL${RESET} — budget identifier(s) found outside the allowlist:"
  echo "$budget_hits"
  fail=1
else
  echo -e "${GREEN}OK${RESET} — no stray budget references."
fi

# ---------------------------------------------------------------------------
# Rule #3 — Chef specialty never rendered.
# ---------------------------------------------------------------------------
# ChefCard is the canonical consumer of chef pool data. It must NEVER read
# `.specialty` / `.specialties` off a chef, and the DOM must never contain
# data-testid="chef-specialty". (The backend includes specialties on chef
# pool entries; keeping the field out of ChefCard input entirely is how we
# keep it out of the rendered tree.)
echo ""
echo "==> ChefCard no-specialty audit (Rule #3)"

chef_hits=""
# Only scan ChefCard source + anywhere else that renders chef data.
# (ChefCard is the only approved render site; call sites pass in primitives.)
if [ -f src/components/game/ChefCard.tsx ]; then
  chef_hits=$(git grep -n -E '\.specialty\b|\.specialties\b|data-testid=["'\'']chef-specialty["'\'']' \
    -- 'src/**/*.ts' 'src/**/*.tsx' \
    ':(exclude)src/types/game.ts' 2>/dev/null || true)
fi

if [ -n "$chef_hits" ]; then
  echo -e "${RED}FAIL${RESET} — chef specialty reference(s) found:"
  echo "$chef_hits"
  fail=1
else
  echo -e "${GREEN}OK${RESET} — no chef-specialty references in rendered code."
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo -e "${GREEN}All UI rules pass.${RESET}"
  exit 0
else
  echo -e "${YELLOW}Audit failed.${RESET} See violations above."
  echo "Allowlist for budget rule: games/bakery-bash/FRONTEND.md § Hide-Budget Audit."
  exit 1
fi
