import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  doc,
  onSnapshot,
  type DocumentData,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { useGame } from "../contexts/GameContext";
import { useGamePhaseNav } from "../hooks/useGamePhaseNav";
import { PageShell } from "../components/ui/PageShell";
import { MarketEmailModal } from "../components/game/MarketEmailModal";
import { parseGamePhase } from "../types/game";

/**
 * FE-06 — `/game/email` phase page.
 *
 * Displays the round-opening market briefing sourced from
 * `rounds/round_{N}.marketEmail` (BE-07). The modal is always open while
 * the game is in a `round_N_email` phase; when the professor advances to
 * `round_N_decide`, this page auto-navigates to the Decide route.
 *
 * Clicking "Got it" is a soft dismiss: the modal closes locally and the
 * page renders a "waiting for the professor" placeholder. Navigation is
 * phase-driven — as soon as the backend flips to `round_N_decide` the
 * auto-route effect below takes the player to `/game/decide`. We don't
 * navigate on dismiss because `GamePage` also redirects email-phase
 * players back to `/game/email`, which would bounce the user in a loop.
 */

interface MarketEmail {
  subject: string | null;
  body: string | null;
  from: string | null;
}

export function EmailPhasePage() {
  useGamePhaseNav();
  const { gameId, currentRound, phase } = useGame();
  const navigate = useNavigate();

  const [email, setEmail] = useState<MarketEmail | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Reset the local dismiss whenever the active round changes, so that
  // each round's email starts fresh with the modal open.
  useEffect(() => {
    setDismissed(false);
  }, [currentRound]);

  // Subscribe to the round doc for the current round's marketEmail.
  useEffect(() => {
    if (!gameId || !currentRound) return;
    const roundRef = doc(db, "games", gameId, "rounds", `round_${currentRound}`);
    const unsubscribe = onSnapshot(
      roundRef,
      (snap) => {
        if (!snap.exists()) {
          setEmail(null);
          return;
        }
        const data = snap.data() as DocumentData;
        const me = (data.marketEmail ?? null) as DocumentData | null;
        setEmail({
          subject: typeof me?.subject === "string" ? me.subject : null,
          body: typeof me?.body === "string" ? me.body : null,
          from: typeof me?.from === "string" ? me.from : null,
        });
      },
      (err) => {
        console.debug("email phase round listener error:", err);
      },
    );
    return unsubscribe;
  }, [gameId, currentRound]);

  // Auto-route to decide when the professor advances.
  useEffect(() => {
    if (!phase) return;
    const parsed = parseGamePhase(phase, currentRound);
    if (parsed.base === "decide") navigate("/game/decide");
    else if (
      parsed.base === "bid_ad" ||
      parsed.base === "bid_chef"
    )
      navigate("/auction");
    else if (parsed.base === "roster") navigate("/game/roster");
    else if (parsed.base === "simulating" || parsed.base === "results_ready")
      navigate("/game");
    else if (parsed.base === "game_over") navigate("/game/conclusion");
  }, [phase, currentRound, navigate]);

  return (
    <PageShell className="email-phase-page">
      {/* Soft backdrop so the page isn't blank if the modal hasn't loaded. */}
      <div className="email-phase-page__placeholder">
        <h1 className="email-phase-page__title">
          Round {currentRound ?? "—"} briefing
        </h1>
        <p className="email-phase-page__hint">
          The professor will move everyone to Decide when you've read the memo.
        </p>
      </div>

      <MarketEmailModal
        open={!dismissed}
        round={currentRound}
        subject={email?.subject ?? null}
        body={email?.body ?? null}
        from={email?.from ?? null}
        onContinue={() => setDismissed(true)}
      />
    </PageShell>
  );
}
