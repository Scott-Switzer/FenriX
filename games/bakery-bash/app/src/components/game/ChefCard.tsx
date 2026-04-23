import type {
  ChefCardInput,
  ChefNationality,
  ChefSkillTier,
} from "../../types/game";

/**
 * FE-04 — Shared chef card used across the chef bid phase (`bid`), the
 * roster phase (`roster`), and win celebrations on the results screen
 * (`won`).
 *
 * Hard UI contract (FRONTEND.md Rule #3):
 *   - Chef specialty is NEVER rendered. The `ChefCardInput` type
 *     deliberately omits `specialties`, so this component cannot
 *     accidentally leak it into the DOM even if a caller passes in the
 *     full `ChefPoolEntry`.
 *   - A regression grep (`scripts/audit-ui-rules.sh`) enforces this at
 *     pre-push time by failing on any dotted-specialty reference or chef-
 *     specialty test-id attribute anywhere under `src/`.
 */
export type ChefCardMode = "bid" | "roster" | "won";

interface ChefCardBaseProps {
  chef: ChefCardInput;
  mode: ChefCardMode;
  className?: string;
  /** Sequential position of this chef in the round's pool (0-indexed). */
  cardIndex?: number;
}

interface ChefCardBidProps extends ChefCardBaseProps {
  mode: "bid";
  /** Current top bid amount for this chef, or `null` while loading / none. */
  topBid?: number | null;
  /** Caller's own pending bid (optional, used by `<AuctionPage>`). */
  myBid?: number | null;
  /** Rendered in the action slot, e.g. a `<BidInput>` or `<button>`. */
  action?: React.ReactNode;
}

interface ChefCardRosterProps extends ChefCardBaseProps {
  mode: "roster";
  /** If `true`, render the lay-off button. Finance/operations click to open modal. */
  canLayoff?: boolean;
  onLayoff?: (chefId: string) => void;
  /** Optional satisfaction %, shown as a small status pill when provided. */
  satisfactionPct?: number | null;
}

interface ChefCardWonProps extends ChefCardBaseProps {
  mode: "won";
  /** Price the player actually paid when winning the auction. */
  wonAmount?: number | null;
}

export type ChefCardProps =
  | ChefCardBidProps
  | ChefCardRosterProps
  | ChefCardWonProps;

const NATIONALITY_FLAG: Record<ChefNationality, string> = {
  american: "🇺🇸",
  french: "🇫🇷",
  italian: "🇮🇹",
  japanese: "🇯🇵",
};

const NATIONALITY_LABEL: Record<ChefNationality, string> = {
  american: "American",
  french: "French",
  italian: "Italian",
  japanese: "Japanese",
};

const SKILL_LABEL: Record<ChefSkillTier, string> = {
  novel: "Novel",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

function formatMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function ChefCard(props: ChefCardProps) {
  const { chef, mode, className, cardIndex } = props;
  const portraitSrc = `/assets/chefs/${chef.nationality}-${chef.gender}.svg`;

  return (
    <article
      className={[
        "chef-card",
        `chef-card--${mode}`,
        `chef-card--skill-${chef.skillTier}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-chef-id={chef.id}
      data-mode={mode}
    >
      {typeof cardIndex === "number" && (
        <span className="chef-card__number">#{cardIndex + 1}</span>
      )}
      <div className="chef-card__portrait">
        <img
          src={portraitSrc}
          alt={`${chef.name}, ${NATIONALITY_LABEL[chef.nationality]} chef`}
          loading="lazy"
        />
        <span
          className="chef-card__flag"
          title={NATIONALITY_LABEL[chef.nationality]}
          aria-hidden="true"
        >
          {NATIONALITY_FLAG[chef.nationality]}
        </span>
      </div>

      <div className="chef-card__body">
        <div className="chef-card__name">{chef.name}</div>

        <div className="chef-card__meta">
          <span
            className={`chef-card__skill chef-card__skill--${chef.skillTier}`}
          >
            {SKILL_LABEL[chef.skillTier]}
          </span>
          <span className="chef-card__nationality">
            {NATIONALITY_LABEL[chef.nationality]}
          </span>
        </div>

        {mode === "bid" && (
          <BidFooter
            topBid={(props as ChefCardBidProps).topBid}
            myBid={(props as ChefCardBidProps).myBid}
            action={(props as ChefCardBidProps).action}
          />
        )}

        {mode === "roster" && (
          <RosterFooter
            chefId={chef.id}
            canLayoff={(props as ChefCardRosterProps).canLayoff}
            onLayoff={(props as ChefCardRosterProps).onLayoff}
            satisfactionPct={(props as ChefCardRosterProps).satisfactionPct}
          />
        )}

        {mode === "won" && (
          <WonFooter wonAmount={(props as ChefCardWonProps).wonAmount} />
        )}
      </div>
    </article>
  );
}

function BidFooter({
  topBid,
  myBid,
  action,
}: {
  topBid?: number | null;
  myBid?: number | null;
  action?: React.ReactNode;
}) {
  return (
    <div className="chef-card__footer chef-card__footer--bid">
      <div className="chef-card__bids">
        <div className="chef-card__bid-row">
          <span className="chef-card__bid-label">Top bid</span>
          <span className="chef-card__bid-value">{formatMoney(topBid)}</span>
        </div>
        {typeof myBid === "number" && myBid > 0 && (
          <div className="chef-card__bid-row chef-card__bid-row--mine">
            <span className="chef-card__bid-label">Your bid</span>
            <span className="chef-card__bid-value">{formatMoney(myBid)}</span>
          </div>
        )}
      </div>
      {action && <div className="chef-card__action">{action}</div>}
    </div>
  );
}

function RosterFooter({
  chefId,
  canLayoff,
  onLayoff,
  satisfactionPct,
}: {
  chefId: string;
  canLayoff?: boolean;
  onLayoff?: (chefId: string) => void;
  satisfactionPct?: number | null;
}) {
  const tier =
    typeof satisfactionPct === "number"
      ? satisfactionPct <= 30
        ? "low"
        : satisfactionPct <= 60
          ? "mid"
          : "high"
      : null;

  return (
    <div className="chef-card__footer chef-card__footer--roster">
      {typeof satisfactionPct === "number" && tier && (
        <span
          className={`chef-card__satisfaction chef-card__satisfaction--${tier}`}
          title="Chef satisfaction"
        >
          {Math.round(satisfactionPct)}% happy
        </span>
      )}
      {canLayoff && (
        <button
          type="button"
          className="btn btn--danger btn--small"
          onClick={() => onLayoff?.(chefId)}
        >
          Lay off
        </button>
      )}
    </div>
  );
}

function WonFooter({ wonAmount }: { wonAmount?: number | null }) {
  return (
    <div className="chef-card__footer chef-card__footer--won">
      <span className="chef-card__won-badge">Won</span>
      {typeof wonAmount === "number" && (
        <span className="chef-card__won-amount">
          for {formatMoney(wonAmount)}
        </span>
      )}
    </div>
  );
}
