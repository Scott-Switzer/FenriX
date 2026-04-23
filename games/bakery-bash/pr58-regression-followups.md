# PR #58 Regression Follow-ups — COMPLETE

> **Context:** PR #58 merged on a stale `main` and its conflict resolution silently reverted parts of PR #57. PR #62 (`fix/csv-inbox-types`) restored the type exports + `GameState.acquiredCsvs` to get `tsc -b` and `eslint` clean again — but the **runtime features** those types supported were still missing. This file tracked the feature-level regressions that needed to be restored, each as its own auditable PR.
>
> **All actionable items shipped as of 2026-04-23.** Item 8c closed without implementation — see its section for why.

**Baseline:** Compare `c348aed` (PR #57 merged) vs current `main` for any item below.
**Opened by:** PR #62 comment at <https://github.com/fenrix-ai/FenriX/pull/62#issuecomment-4302991939>
**Last updated:** 2026-04-23 (post-#75, 8c closed)

---

## How to read

- Each item is an **independent PR**. Do not bundle.
- **Status** values: `todo`, `in-progress (branch)`, `in-review (PR#)`, `shipped (PR#)`, `closed (won't-do)`.
- Before starting any item, `git diff c348aed main -- <path>` to see exactly what PR #58's merge dropped.

---

## 1. `ADD_ACQUIRED_CSV` reducer case — CSV Inbox population

**Status:** shipped (PR #63)
**Files:** `games/bakery-bash/app/src/contexts/GameContext.tsx`
**What broke:** The reducer case that pushes a new `AcquiredCsv` into `state.acquiredCsvs` was deleted. Without it, `acquiredCsvs` stays `[]` forever and the inbox renders permanently empty.
**Acceptance:** Dispatching `{ type: 'ADD_ACQUIRED_CSV', payload: <AcquiredCsv> }` appends the entry; duplicate `id`s are not added twice.
**Bundled with:** items 2 + 3 (CSV Inbox feature end-to-end).

## 2. `CsvInboxModal` mount in `RoundHeader`

**Status:** shipped (PR #63)
**Files:** `games/bakery-bash/app/src/components/game/RoundHeader.tsx`
**What broke:** The header's mail-icon button no longer opens the inbox modal — it still triggers the legacy direct-download behaviour. The `<CsvInboxModal>` component file compiles but is imported by nothing at HEAD, so the feature is unreachable.
**Acceptance:** Clicking the mail button opens the inbox modal; it lists every `AcquiredCsv` currently in `GameState.acquiredCsvs`; closing works; re-clicking the Download link on a row re-downloads without re-charging.
**Bundled with:** items 1 + 3.

## 3. Purchasable-data buttons in `GameSidebar`

**Status:** shipped (PR #63)
**Files:** `games/bakery-bash/app/src/components/game/GameSidebar.tsx`
**What broke:** The Finance-gated buttons to purchase competitor intel + Tier 1 / Tier 2 chef CSVs were removed. Even with items 1 + 2 restored, users have no way to populate `acquiredCsvs`.
**Acceptance:** Finance role sees three purchase buttons with visible costs; clicking charges the team budget, dispatches `ADD_ACQUIRED_CSV`, and the newly acquired CSV appears in the inbox within the same render pass.
**Bundled with:** items 1 + 2.

## 4. `RoundEvent` / `RoundEventKind` types + events system

**Status:** shipped (PR #71)
**Files:** `games/bakery-bash/app/src/types/game.ts`, `games/bakery-bash/app/src/pages/phases/ResultsPhase.tsx`, `games/bakery-bash/app/src/pages/phases/SimulatePhase.tsx`, `games/bakery-bash/app/src/styles/global.css`.
**What broke:** The `RoundEvent` type + `events?: RoundEvent[]` field on `RoundResult` were dropped; the `EventCard` renderer + "Events" section + legacy-burglary synthesizer were dropped from `ResultsPhase`; all `.event-card*` CSS was dropped.
**Scope clarification (audited in PR #71):** The doc originally listed `AdWin` as a missing type — no such top-level type existed at baseline. `AdWinnerBanner.tsx` has a local `AdWinnerEntry` interface identical between `c348aed` and current `main`; nothing to restore on the ad-winners side.
**Backend stays as-is:** `backend/functions/modules/simulation.js` emits the flat `burglary` / `burglaryAmount` / `burglaryDays` fields at both baseline `c348aed` AND current `main`. The frontend synthesizer pattern is the permanent design; no backend change required.

## 5. `ChefListing.minBidFloor`

**Status:** shipped (PR #66)
**Files:** `games/bakery-bash/app/src/types/game.ts` (add field), `games/bakery-bash/app/src/pages/AuctionPage.tsx` (render + client-side floor check), possibly `games/bakery-bash/backend/functions/modules/chef-system.js` if server needs to echo the value.
**What broke:** Per-chef minimum bid floor is no longer rendered or enforced on the client. Backend still rejects under-floor bids (via `MIN_BID_FLOOR_MULTIPLIERS` in `chef-system.js`), so the UX is: user submits a too-low bid and sees a bare error message instead of proactive UI guardrails.
**Acceptance:** `ChefCard` shows the minimum bid; bid input disables / shows inline validation below the floor; server still double-checks.
**Tracked in parallel:** Apr 22 `playtesting-apr22-remaining-tasks.md` BE-R05 (server-side) — coordinate.

## 6. `PLAYER_ROLE_LABELS`-delegating owner-copy helpers

**Status:** shipped (PR #70)
**Files:** `games/bakery-bash/app/src/types/game.ts`.
**What broke:** The 4 `ownerOf*` helpers exist but return hardcoded strings instead of delegating to `PLAYER_ROLE_LABELS`. Most visibly, `ownerOfAdBids()` returns `"Advertising"` while `PLAYER_ROLE_LABELS.advertising` is `"Bidder"` — so the auction page tooltip says "Your Advertising teammate submits this decision" while the lobby role-picker and How-to-Play page call that same role "Bidder".
**Acceptance:** All owner-copy strings (e.g., "Your Bidder is…", "Finance owns pricing", etc.) derive from one source of truth.

## 7. `GameProgressBar` component + mount in `RoundHeader`

**Status:** shipped (PR #69)
**Files:** `games/bakery-bash/app/src/components/game/RoundHeader.tsx` (remount), `games/bakery-bash/app/src/styles/global.css` (`.round-header__progress` + `.game-progress*` rules).
**What broke:** PR #62 restored the `GameProgressBar.tsx` component file but not the mount or its CSS. With no mount the round-progress visualization strip inside `RoundHeader` is absent; with no CSS it'd render unstyled.
**Acceptance:** Progress bar renders below the phase banner; `currentRound / totalRounds` filled portion is visible; matches `c348aed` design.

## 8. ~3500-line UX polish sweep from PR #57

**Status:** partially scoped — split into sub-items below.
**Baseline audit:** `git diff c348aed main -- games/bakery-bash/app/src/` totals ~4000 lines across 21 files. Auditing each cluster:

### Already addressed (drop from scope)

| Cluster | Handled by |
|---------|------------|
| Simulation bakery-interior art + animation | **Superseded** by `feat/bakery-scene-v2` worktree (Undertale-style pixel rewrite) |
| Round-email "Round N" hero | PR #48 |
| Event cards on ResultsPhase | Item 4 / PR #71 |
| Auction page polish (~323 lines) | Heavily reworked by PRs #54 / #58 / #66 / #68 — re-landing would conflict |
| Game page layout (~215 lines) | PR #68 |
| Professor page (~223 lines) | PR #54 |

### Remaining sub-items

### 8a. How-to-Play page copy refresh

**Status:** shipped (PR #73)
**Files:** `games/bakery-bash/app/src/pages/HowToPlayPage.tsx`, `games/bakery-bash/app/src/styles/global.css` (chef-tiers rules).
**What broke:** Round order, Bidder copy, chef-tier table, new Simulation Round entry, Results CSV note, and CSV Inbox entry were reverted to a shorter, less accurate version.
**Acceptance:** Round order reads **Ad Auction → Chef Auction → Decisions → Simulation → Results**; Ad Auction card calls out the Bidder + foot-traffic variation; Chef Auction card explains the sous-chef-station distinction and links to the CSV tiers; CSV Inbox entry exists.

### 8b. Conclusion page podium + confetti

**Status:** shipped (PR #74)
**Files:** `games/bakery-bash/app/src/pages/ConclusionPage.tsx`, `games/bakery-bash/app/src/styles/global.css` (podium + confetti rules).
**What broke:** The celebratory hero ("Final Whistle" / 🎉 Game Over, Bakers 🎉), confetti overlay, and gold/silver/bronze podium were replaced with a plainer "The doors are closed." header.
**Acceptance:** Game Over screen shows the celebratory hero with tagline, confetti overlay animation, and a 3-slot podium for the top leaderboard entries.
**Size:** ~150 line diff including CSS.

### 8c. Landing page — Create/Join Team modal flow

**Status:** closed (won't-do)
**Files (hypothetical):** `games/bakery-bash/app/src/pages/LandingPage.tsx`, associated CSS.
**What PR #57 had:** A modal-based team create/join flow — each primary button opened a popup (modal) with its form. After creating a team the main card displayed the new team's logo + name as confirmation before the player committed to "Join Game".
**What's on main instead:** PR #53's named-team flow — a single-page Create/Join **toggle** with the forms inline. For Join, it calls a `getTeamsInLobby` server function and renders a selectable grid of teams with their logos + member counts. Create is a `createTeam` transaction that seats the creator as Finance in one write.
**Why closed:** Not a drop-in restoration. PR #57's modal JSX was written against the old backend that PR #53 has since replaced. Re-landing the modals would require rewriting them against PR #53's `createTeam` / `getTeamsInLobby` callables — effectively a UX redesign on top of a new data layer, not a restoration. The current toggle UI on main is functional; modals-vs-toggles is a design preference best decided from scratch if/when desired, not by reverting mid-stack.

### 8d. Remaining Conclusion page CSS (stats / leaderboard / rounds)

**Status:** shipped (PR #75)
**Files:** `games/bakery-bash/app/src/styles/global.css`.
**What broke:** The Your-bakery stat-card grid, Leaderboard table card, and Per-round expansion list lost all their styling (`__yours-grid`, `__stat*`, `__leaderboard`, `__board-table*`, `__board-row--you`, `__round-*`, `__mini-kpi*`, `__footer` — 19 selectors in total). With #74 restoring only the hero + confetti + podium, the rest of the page rendered unstyled.
**Acceptance:** All sections below the podium render with the cream/caramel card styling and pixel-font labels; current-player row in the leaderboard is highlighted; warn variant on mini-KPI chips turns red.

**Approach:** One sub-item per PR.

---

## Ground rules

1. **One item per PR** unless explicitly bundled above (items 1–3 are one feature).
2. **Baseline diff** (`git diff c348aed main -- <path>`) before touching any file — so reviewers can audit "this is a restoration, not new design".
3. **tsc + eslint clean** before pushing. PR #62 set the baseline at zero errors.
4. **Runtime verify** in the emulator for anything user-visible (items 1–3, 5, 7, 8). Tsc-only restorations can skip, but call it out in the PR body.
