import { useNavigate } from "react-router-dom";
import { PageShell } from "../components/ui/PageShell";

const HOW_TO_PLAY_STAGES = [
  {
    label: "Decisions",
    tagline: "Your bakery, your call.",
    body: "Each round, assign staff to stations, set how much to stock, and decide which maintenance jobs to prioritise. Every hire and every unit ordered costs money — spend wisely, because it all comes out of your revenue.",
  },
  {
    label: "Ad Auction",
    tagline: "The loudest bakery wins the crowd.",
    body: "Teams bid competitively for four advertising slots: TV, Radio, Newspaper, and Billboard. The highest bidder holds that ad for the entire round. Ownership resets every auction — no team can hold an ad forever.",
  },
  {
    label: "Chef Auction",
    tagline: "Great chefs don't come cheap.",
    body: "One chef pool is available each round. Teams bid to recruit them. Each chef independently boosts production at their station — their output adds on top of your existing team's. Chef speed multipliers do not stack across chefs.",
  },
  {
    label: "Results",
    tagline: "The receipts don't lie.",
    body: "After every round, see your revenue, costs, customer count, and where you stand on the leaderboard. Review carefully — the next round starts right after.",
  },
];

export function HowToPlayPage() {
  const navigate = useNavigate();
  return (
    <PageShell className="how-to-play">
      <div className="how-to-play__header">
        <button className="btn btn--ghost how-to-play__back" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <h1 className="how-to-play__title">How to Play</h1>
      </div>
      <div className="how-to-play__stages">
        {HOW_TO_PLAY_STAGES.map((stage) => (
          <div key={stage.label} className="how-to-play__card">
            <span className="how-to-play__card-label">{stage.label}</span>
            <h2 className="how-to-play__card-tagline">{stage.tagline}</h2>
            <p className="how-to-play__card-body">{stage.body}</p>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
