import { useGame } from "../../contexts/GameContext";

const BASE_MENU = ["Croissant", "Cookie", "Bagel"] as const;
const UNLOCKABLE = ["Sandwich", "Latte", "Matcha Latte"] as const;

export function DecidePhase() {
  const { currentRound, totalRounds } = useGame();

  return (
    <section className="decide-phase">
      <h2>
        Make Your Decisions — Round {currentRound} of {totalRounds}
      </h2>

      <div className="decide-phase__grid">
        <div className="decide-phase__section">
          <h3>Menu Prices &amp; Stock</h3>
          {BASE_MENU.map((item) => (
            <div key={item} className="decide-phase__item">
              <span>{item}</span>
              <input type="number" placeholder="Price ($)" min={0} step={0.5} />
              <input type="number" placeholder="Qty" min={0} step={1} />
            </div>
          ))}
        </div>

        <div className="decide-phase__section">
          <h3>Unlock New Items</h3>
          {UNLOCKABLE.map((item) => (
            <div key={item} className="decide-phase__item">
              <span>{item}</span>
              <button className="btn btn--small" disabled>
                Unlock
              </button>
            </div>
          ))}
        </div>

        <div className="decide-phase__section">
          <h3>Staffing</h3>
          <label className="form-field">
            <span className="form-field__label">Number of Staff</span>
            <input
              type="number"
              className="form-field__input"
              placeholder="e.g. 3"
              min={1}
              max={20}
            />
          </label>
        </div>
      </div>

      <button className="btn btn--primary decide-phase__submit">
        Submit Decisions
      </button>
    </section>
  );
}
