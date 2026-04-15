import { useState } from "react";
import { useGame } from "../../contexts/GameContext";
import { useAuth } from "../../contexts/AuthContext";
import {
  updatePendingDecision,
  callSubmitDecisions,
} from "../../hooks/useFirebase";
import type { MenuItemId } from "../../types/game";

const MENU_ITEMS: Array<{ id: MenuItemId; name: string; base: boolean }> = [
  { id: "croissant", name: "Croissant", base: true },
  { id: "cookie", name: "Cookie", base: true },
  { id: "bagel", name: "Bagel", base: true },
  { id: "sandwich", name: "Sandwich", base: false },
  { id: "latte", name: "Latte", base: false },
  { id: "matchaLatte", name: "Matcha Latte", base: false },
];

export function DecidePhase() {
  const { currentRound, totalRounds, gameId, player } = useGame();
  const { user } = useAuth();

  const [menu, setMenu] = useState<Record<MenuItemId, boolean>>({
    croissant: true,
    cookie: true,
    bagel: true,
    sandwich: false,
    latte: false,
    matchaLatte: false,
  });
  const [prices, setPrices] = useState<Record<MenuItemId, number>>({
    croissant: 5,
    cookie: 4,
    bagel: 6,
    sandwich: 8,
    latte: 6,
    matchaLatte: 7,
  });
  const [quantities, setQuantities] = useState<Record<MenuItemId, number>>({
    croissant: 20,
    cookie: 15,
    bagel: 10,
    sandwich: 0,
    latte: 0,
    matchaLatte: 0,
  });
  const [staffCount, setStaffCount] = useState(3);
  const [adSpend, setAdSpend] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!gameId || !user) return;
    setError(null);
    setSubmitting(true);

    try {
      // Write pending decision to Firestore
      await updatePendingDecision(gameId, user.uid, {
        staffCount,
        adSpend,
        menu,
        productPrices: prices,
        quantities,
      });

      // Call the Cloud Function to lock it in
      await callSubmitDecisions(gameId);
      setSubmitted(true);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to submit decisions."
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <section className="decide-phase">
        <h2>Decisions Submitted</h2>
        <p>Waiting for other players and the professor to advance…</p>
      </section>
    );
  }

  return (
    <section className="decide-phase">
      <h2>
        Make Your Decisions — Round {currentRound} of {totalRounds}
      </h2>

      {player && (
        <p className="decide-phase__budget">
          Budget: <strong>${player.budget.toLocaleString()}</strong>
        </p>
      )}

      <div className="decide-phase__grid">
        <div className="decide-phase__section">
          <h3>Menu Prices &amp; Stock</h3>
          {MENU_ITEMS.filter((item) => menu[item.id]).map((item) => (
            <div key={item.id} className="decide-phase__item">
              <span>{item.name}</span>
              <input
                type="number"
                placeholder="Price ($)"
                min={0}
                step={0.5}
                value={prices[item.id]}
                onChange={(e) =>
                  setPrices({ ...prices, [item.id]: Number(e.target.value) })
                }
              />
              <input
                type="number"
                placeholder="Qty"
                min={0}
                step={1}
                value={quantities[item.id]}
                onChange={(e) =>
                  setQuantities({
                    ...quantities,
                    [item.id]: Number(e.target.value),
                  })
                }
              />
            </div>
          ))}
        </div>

        <div className="decide-phase__section">
          <h3>Unlock New Items</h3>
          {MENU_ITEMS.filter((item) => !item.base).map((item) => (
            <div key={item.id} className="decide-phase__item">
              <span>{item.name}</span>
              <button
                className={`btn btn--small${menu[item.id] ? " btn--active" : ""}`}
                onClick={() => setMenu({ ...menu, [item.id]: !menu[item.id] })}
              >
                {menu[item.id] ? "✓ Unlocked" : "Unlock"}
              </button>
            </div>
          ))}
        </div>

        <div className="decide-phase__section">
          <h3>Staffing</h3>
          <label className="form-field">
            <span className="form-field__label">
              Number of Staff (${50}/each)
            </span>
            <input
              type="number"
              className="form-field__input"
              value={staffCount}
              onChange={(e) => setStaffCount(Number(e.target.value))}
              min={1}
              max={20}
            />
          </label>

          <h3>Ad Spend</h3>
          <label className="form-field">
            <span className="form-field__label">Total Ad Spend ($)</span>
            <input
              type="number"
              className="form-field__input"
              value={adSpend}
              onChange={(e) => setAdSpend(Number(e.target.value))}
              min={0}
            />
          </label>
        </div>
      </div>

      {error && <p className="decide-phase__error">{error}</p>}

      <button
        className="btn btn--primary decide-phase__submit"
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? "Submitting…" : "Submit Decisions"}
      </button>
    </section>
  );
}
