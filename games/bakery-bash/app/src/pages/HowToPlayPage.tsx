import { useNavigate } from "react-router-dom";
import { PageShell } from "../components/ui/PageShell";

/**
 * How-to-play content (refreshed Apr 24, A24-I02).
 *
 * Page layout, top to bottom:
 *   1. Hero intro box — one-line headline + "what this game is" paragraph.
 *   2. Role boxes — 4 cards in canonical role colors (sage / caramel /
 *      berry / honey) explaining what each teammate owns.
 *   3. Stages — 7 cards matching the shipped phase order:
 *      Email → Ad Auction → Chef Auction → Roster → Decide →
 *      Simulate → Results (+ standing CSV Inbox reminder).
 *   4. Chef Tiers table — kept unchanged, ties into purchasable chef CSV.
 */
// S-03 (2026-04-29): role copy reflects the post-playtest role split (Q6).
// Quantities live with Finance now (M-17). Chef bids live with the renamed
// Analyst now (M-18, B-05, S-07). Backend role strings unchanged.
const HOW_TO_PLAY_ROLES = [
  {
    key: "operations",
    label: "Operations",
    tagline: "Runs the kitchen.",
    body:
      "Submits the team's staffing decisions in Decide: sous-chef hires, maintenance, equipment upgrades. Manages the chef roster — including lay-offs.",
  },
  {
    key: "advertising",
    label: "Analyst",
    tagline: "Reads the market.",
    body:
      "Submits ad bids in the Ad Auction and chef bids in the Chef Auction. Buys data sets on the Results screen and downloads the team's monthly CSV. The team's intel and procurement role.",
  },
  {
    key: "finance",
    label: "Finance",
    tagline: "Sets the prices.",
    body:
      "Submits prices and quantities in Decide. Owns the team's pricing strategy: how much you sell and what you charge for it.",
  },
  {
    key: "solo",
    label: "Solo",
    tagline: "Default with <3 people.",
    body:
      "When your team has 1 or 2 people, everyone runs as Solo — any teammate can submit anything. Once a third teammate joins, roles auto-assign to Operations / Analyst / Finance.",
  },
] as const;

const HOW_TO_PLAY_STAGES = [
  {
    label: "Round Briefing",
    tagline: "Read the morning email.",
    body: "Every round opens on a brief that tells you which round you're in and how much time remains before the next phase. You don't do anything here — use the time to talk strategy with your team before bids start flying.",
  },
  {
    label: "Ad Auction",
    tagline: "The loudest bakery wins the crowd.",
    body: "Your Analyst submits ad bids. Teams compete for four slots — TV, Radio, Newspaper, Billboard. This is a sealed-bid auction: submit your best bid before the timer runs out — you won't see opponents' bids until results. The highest bidder locks each slot for the whole round.",
  },
  {
    label: "Chef Auction",
    tagline: "Great chefs don't come cheap.",
    body: "Your Analyst submits chef bids. A fresh pool of specialty chefs goes up for auction each round. Sealed-bid: nobody sees your number, you don't see theirs — the highest bid wins. Specialty chefs don't have station assignments; they boost the whole bakery's output. Sous chefs still live on stations.",
  },
  {
    label: "Kitchen Roster",
    tagline: "Three specialty chefs max.",
    body: "After the chef auction, your team reviews who's in your kitchen. You can keep up to three specialty chefs — if you picked up a fourth, your Operations teammate lays one off before continuing.",
  },
  {
    label: "Decide",
    tagline: "Your bakery, your call.",
    body: "Assign sous chefs to stations, set your menu quantities, price each product, and schedule maintenance. Every hire and every unit ordered costs money — spend wisely, because it all comes out of your revenue.",
  },
  {
    label: "Simulate",
    tagline: "Lights on — customers incoming.",
    body: "See your bakery come to life! Spectate a simulation of your bakery over the course of a month. Watch the menu sell down in real time; sold-out products get stamped so you can see what ran short.",
  },
  {
    label: "Results",
    tagline: "The receipts don't lie.",
    body: "After every round, see your profit, customer count, satisfaction, maintenance state, and leaderboard position. Download a CSV of the round's daily data — one row per day. Curveball events like burglaries and inspections show up as cards so you can see exactly when and how they hit.",
  },
  {
    label: "CSV Inbox",
    tagline: "Every file you've earned, in one place.",
    body: "Tap the CSV Inbox button in the header to open a scrollable panel listing every data file your team has acquired: the results CSV, any competitor intel you've bought, and purchasable chef-data CSVs. Pick which file to download — nothing auto-downloads when you open the panel.",
  },
];

const CHEF_TIERS = [
  {
    tier: "Tier 1 — Low",
    multiplier: "1.0×",
    body: "Entry-level specialty chefs. Solid production, cheap to acquire.",
  },
  {
    tier: "Tier 2 — Medium",
    multiplier: "1.5×",
    body: "Experienced specialty chefs. Moderate bid floor, reliable output.",
  },
  {
    tier: "Tier 3 — High",
    multiplier: "2.0×",
    body: "Top-tier specialty chefs. High minimum bid, but double production.",
  },
];

export function HowToPlayPage() {
  const navigate = useNavigate();
  return (
    <PageShell className="how-to-play">
      <div className="how-to-play__header">
        <button
          className="btn btn--ghost how-to-play__back"
          onClick={() => navigate(-1)}
        >
          ← Back
        </button>
        <h1 className="how-to-play__title">How to Play</h1>
      </div>

      <section className="how-to-play__intro" aria-label="Game overview">
        <div className="how-to-play__intro-headline">
          Run a bakery. Read the market. Beat the class.
        </div>
        <p className="how-to-play__intro-body">
          You run a bakery. Each round, you make data-driven decisions about
          what to bake, how to price it, what to advertise, and which chefs
          to hire. You're competing against the other bakeries in the class —
          whoever reads the market best and out-strategizes the room wins.
          The game is 5 rounds; your cumulative net profit decides the
          champion.
        </p>
      </section>

      <section className="how-to-play__roles" aria-label="Team roles">
        <h2 className="how-to-play__section-title">Roles on your team</h2>
        <div className="how-to-play__role-grid">
          {HOW_TO_PLAY_ROLES.map((role) => (
            <div
              key={role.key}
              className={`how-to-play__role-card how-to-play__role-card--${role.key}`}
            >
              <span className="how-to-play__role-label">{role.label}</span>
              <h3 className="how-to-play__role-tagline">{role.tagline}</h3>
              <p className="how-to-play__role-body">{role.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="how-to-play__stages-section" aria-label="Round stages">
        <h2 className="how-to-play__section-title">Round flow</h2>
        <div className="how-to-play__stages">
          {HOW_TO_PLAY_STAGES.map((stage) => (
            <div key={stage.label} className="how-to-play__card">
              <span className="how-to-play__card-label">{stage.label}</span>
              <h2 className="how-to-play__card-tagline">{stage.tagline}</h2>
              <p className="how-to-play__card-body">{stage.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="how-to-play__chef-tiers">
        <h2 className="how-to-play__chef-tiers-title">Chef Tiers</h2>
        <p className="how-to-play__chef-tiers-hint">
          Three specialty-chef tiers appear in the Chef Auction. Higher tier
          means a higher minimum bid, but also a bigger production multiplier.
        </p>
        <table className="how-to-play__chef-tier-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Multiplier</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {CHEF_TIERS.map((t) => (
              <tr key={t.tier}>
                <td>{t.tier}</td>
                <td>{t.multiplier}</td>
                <td>{t.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </PageShell>
  );
}
