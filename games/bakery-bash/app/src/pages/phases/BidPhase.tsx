import { useState } from "react";
import { useGame } from "../../contexts/GameContext";
import { useAuth } from "../../contexts/AuthContext";
import {
  updatePendingBids,
  callSubmitDecisions,
} from "../../hooks/useFirebase";
import type { AdType } from "../../types/game";

const AD_TYPES: AdType[] = ["TV", "Radio", "Newspaper", "Billboard"];

export function BidPhase() {
  const { gameId } = useGame();
  const { user } = useAuth();

  const [selectedAd, setSelectedAd] = useState<AdType | null>(null);
  const [adBidAmount, setAdBidAmount] = useState(0);
  const [chefBidAmount, setChefBidAmount] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!gameId || !user) return;
    setError(null);
    setSubmitting(true);

    try {
      // Write bids to Firestore
      await updatePendingBids(gameId, user.uid, {
        adBid: { adType: selectedAd, amount: adBidAmount },
        chefBid: { amount: chefBidAmount },
      });

      // Lock in the bids via Cloud Function
      // Note: submitDecisions also captures bids since they're in pendingBids
      await callSubmitDecisions(gameId);
      setSubmitted(true);
    } catch (err: unknown) {
      // If already submitted from decide phase, that's fine
      if (err instanceof Error && err.message.includes("already")) {
        setSubmitted(true);
      } else {
        setError(err instanceof Error ? err.message : "Failed to submit bids.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <section className="bid-phase">
        <h2>Bids Submitted</h2>
        <p>Waiting for the auction to resolve…</p>
      </section>
    );
  }

  return (
    <section className="bid-phase">
      <h2>Auction Round</h2>

      <div className="bid-phase__auction">
        <h3>Ad Auction — pick one type and bid</h3>
        <div className="bid-phase__cards">
          {AD_TYPES.map((ad) => (
            <div
              key={ad}
              className={`bid-phase__card${selectedAd === ad ? " bid-phase__card--selected" : ""}`}
              onClick={() => setSelectedAd(ad)}
              style={{ cursor: "pointer" }}
            >
              <h4>{ad}</h4>
              {selectedAd === ad && (
                <input
                  type="number"
                  placeholder="Your bid ($)"
                  min={0}
                  value={adBidAmount}
                  onChange={(e) => setAdBidAmount(Number(e.target.value))}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="bid-phase__auction">
        <h3>Chef Auction</h3>
        <div className="bid-phase__cards">
          <div className="bid-phase__card">
            <h4>Head Chef</h4>
            <p className="bid-phase__skill">Skill: revealed after auction</p>
            <input
              type="number"
              placeholder="Your bid ($)"
              min={0}
              value={chefBidAmount}
              onChange={(e) => setChefBidAmount(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      {error && <p className="bid-phase__error">{error}</p>}

      <button
        className="btn btn--primary bid-phase__submit"
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? "Submitting…" : "Submit Bids"}
      </button>
    </section>
  );
}
