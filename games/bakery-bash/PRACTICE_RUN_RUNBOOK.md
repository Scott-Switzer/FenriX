# Practice-Run Runbook — Bakery Bash 70-Player Session

A tight checklist for the practice run (and the real session). Read top-to-bottom; tick boxes as you go.

If something breaks mid-session, jump to the [Recovery procedures](#recovery-procedures) section at the bottom.

---

## ~24 hours before

### 1. Deploy everything to production

All scaling-plan PRs are merged to `main`. Bundle them in one deploy:

```bash
# Functions + Firestore rules
cd games/bakery-bash/backend
firebase deploy --only functions,firestore:rules --project <prod-project-id>

# Hosting (frontend)
cd ../app
npm run build
firebase deploy --only hosting --project <prod-project-id>
```

**Verify in Firebase console (Functions → Triggers tab):**
- [ ] `onTopBidsShardWritten` (PR #98)
- [ ] `onSubmissionShardWritten` (PR #98)
- [ ] `onSubmittedCountShardWritten` (PR #103, T3.3)
- [ ] `onDecisionSubmitted` (existing)

**And in Functions list:**
- [ ] `createSnapshot` (PR #107, T2.4)
- [ ] `restoreSnapshot` (PR #107, T2.4)
- [ ] All hot callables show a fresh revision: `submitBids`, `submitDecision`, `submitPrices`, `advanceGamePhase`, `joinGame`, `createTeam`

### 2. Solo smoke test against production

Use a throwaway game id, just you in two browser windows.

- [ ] Open `https://<prod-domain>/professor` → click **Create Game** → join code shows
- [ ] Click **Warm up servers** → ~5–8s "warming" pill, then "warm" badge with elapsed time
- [ ] In an incognito window: open the join URL, pick "Solo", join → name shows in roster
- [ ] Click **Start Game** in the prof window → watch for an auto-snapshot to land within ~5s
  - Verify: prof page shows **"Last saved: round 1 · …"** under the readiness bar
- [ ] Advance through one round (decide → bid_ad → bid_chef → roster → simulating → results)
- [ ] In the prof window, verify the **disconnect banner does NOT appear** while your player tab is in the foreground
- [ ] Background the player tab for 90s; verify the disconnect banner appears on the prof page within ~70s
- [ ] Foreground the player tab; banner clears within 30s

### 3. Recovery dry-run

While in the throwaway game, trigger a save + restore loop:

- [ ] Click **Save Now** → status pill shows snapshot size + ms duration
- [ ] Advance phase a couple times, place some bids
- [ ] Click **Restart from last save** → typed-confirmation dialog appears
- [ ] Type `RESTORE round_<N>` exactly → click **Confirm restore**
- [ ] Wait ~3–5s for the destructive write
- [ ] Verify the player tab still loads after a refresh (anonymous Firebase auth UID persists)
- [ ] Verify the game is paused; click **Resume Game** to keep going

### 4. Pre-warm the load test (optional, if you have time)

```bash
cd games/bakery-bash/backend
# Replace with a throwaway production game id.
npm run loadtest:auction -- --teams 25 --stagger 5000 --game-id loadtest_<timestamp>
```

Expect: 100% success, p95 latency under ~500ms. If anything is failing, **stop and triage** before the practice run — the auction is the most likely thing to bite.

---

## ~30 minutes before the session

- [ ] Clear browser cache on the projector laptop (Cmd+Shift+R / Ctrl+Shift+R)
- [ ] Pull up `https://<prod-domain>/professor` and sign in
- [ ] Verify the professor custom claim or `professorUid` is set on your account
- [ ] Have a second browser window ready (or a phone) so you can watch what students see

## ~5 minutes before students arrive

- [ ] Click **Create Game** with the right `totalRounds` (default 5)
- [ ] **Click "Warm up servers"** — wait for the green "warm" badge before opening the join code
- [ ] Share the join code / link with the class

## At session start

- [ ] Watch the roster fill up. The **disconnect banner** here is OK during initial join — wait until ~30s after your last expected joiner before worrying.
- [ ] Once everyone (or near-everyone) has joined, click **Start Game**
- [ ] An **auto-snapshot fires immediately** (start of round 1). You'll see "Last saved: round 1 · …" appear within a few seconds.

## During each round

The flow is: `email → decide → bid_ad → bid_chef → roster → simulating → results`.

**Watch for:**
- 🟢 **Readiness badge** ("All teams ready") — safe to advance
- 🔴 **Waiting count** — how many teams haven't submitted yet
- 🟠 **Disconnect banner** — if anyone shows up here, IM them or call them out by name to refresh

**At the start of each new round** the auto-snapshot fires. The "Last saved" timestamp updates. You should see this every ~5–10 minutes.

---

## Recovery procedures

### "Half my class is showing as disconnected"

Most likely cause: their tabs went idle (laptop slept, switched apps, etc.). Their listeners may also be in a disconnected state and showing stale state on screen.

1. Make an announcement: "Everyone, please refresh your browser tab."
2. Their anonymous Firebase auth UID persists across refresh, so they auto-rejoin without re-entering their bakery name.
3. The disconnect banner should clear within ~30s as new presence pings land.

### "The game looks frozen — phase isn't advancing"

1. **Don't** spam-click Advance. Pause the game first (click **Pause Game**).
2. Check Firebase console → Functions → logs for the most recent `advanceGamePhase` invocation. Look for an error.
3. If the phase is `simulating` and stuck > 60s, click **Retry Stuck Simulation** (it appears under Pause when phase = `simulating`).
4. If still stuck after that → use the panic button below.

### "Something's wrong with this round and I need to start it over"

This is exactly what T2.4 is for.

1. Click **Restart from last save** (red button below Reset Game)
2. Confirmation dialog opens; the most-recent snapshot is shown (round + time)
3. Type `RESTORE round_<N>` exactly (whatever round the dialog shows)
4. Click **Confirm restore** — game pauses, drift docs are deleted, snapshot is written back
5. Announce: "Everyone refresh your browser. We're restarting this round."
6. Once the disconnect banner clears (or close to it), click **Resume Game**

The auto-snapshot at the start of every round means you can recover any round at minimum.

### "Production is on fire and I need to fall back to the CLI tools"

The CLI scripts still work as a belt-and-braces fallback (PR #98 and the T2.4 refactor share the same module).

```bash
cd games/bakery-bash/backend
# Take a fresh snapshot to local disk before you do anything destructive:
npm run snapshot -- <gameId> --prod

# Restore from a known-good snapshot:
npm run restore -- ./snapshots/<gameId>/latest.json --prod --pause-on-restore --clean
# Type RESTORE <gameId> when prompted.
```

After a CLI restore: tell players to refresh.

### "I don't know what's wrong but the prof page won't load"

Dump the game state to disk so it's preserved, then start a new game:

```bash
cd games/bakery-bash/backend
npm run snapshot -- <gameId> --prod    # preserve the state
```

Then create a new game from the prof page UI. The original game's data is in `./snapshots/<gameId>/` for postmortem.

---

## After the practice run

- [ ] Capture issues in a doc — what broke, what was confusing, what almost broke
- [ ] If any team-of-3 had pendingBids contention show up as visible lag, **T2.2** (cascade-write fix) is worth doing before the real session
- [ ] If the disconnect banner had a lot of false positives during normal play, tune the staleness threshold (currently 60s in `ProfessorPage.tsx`)
- [ ] If anyone hit a cold-start delay > 3s on their first action, the warm-up button wasn't clicked OR was clicked too early — clarify the timing for next time
