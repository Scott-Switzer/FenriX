const AD_TYPES = ["TV", "Radio", "Newspaper", "Billboard"] as const;

export function BidPhase() {
  return (
    <section className="bid-phase">
      <h2>Auction Round</h2>

      <div className="bid-phase__auction">
        <h3>Ad Auction (1 min)</h3>
        <div className="bid-phase__cards">
          {AD_TYPES.map((ad) => (
            <div key={ad} className="bid-phase__card">
              <h4>{ad}</h4>
              <input type="number" placeholder="Your bid ($)" min={0} />
            </div>
          ))}
        </div>
      </div>

      <div className="bid-phase__auction">
        <h3>Chef Auction (1 min)</h3>
        <div className="bid-phase__cards">
          {[1, 2, 3].map((chef) => (
            <div key={chef} className="bid-phase__card">
              <h4>Chef #{chef}</h4>
              <p className="bid-phase__skill">Skill: ???</p>
              <input type="number" placeholder="Your bid ($)" min={0} />
            </div>
          ))}
        </div>
      </div>

      <button className="btn btn--primary bid-phase__submit">
        Submit Bids
      </button>
    </section>
  );
}
