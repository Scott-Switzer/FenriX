import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { useGame, useGameDispatch } from "../../contexts/GameContext";
import {
  BASE_MENU,
  DEFAULT_PRODUCT_UNLOCK_COST,
  roleOwnsPricing,
  type ProductKey,
  type StationId,
} from "../../types/game";

import { functions } from "../../lib/firebase";
import { PRICE_ZONES } from "../../lib/pricing";
import { PriceInput } from "./PriceInput";
import { totalStaffCost, totalProductCost } from "../../lib/cost";
import { tierUpgradeCost } from "../../lib/equipment";

// B-02 (2026-04-29): hard cap on per-product quantity. Q17 confirmed the
// 9,999-unit ceiling per row. Backend enforces its own server-side
// production caps separately; this is the FE typo guard.
const BAKERY_QTY_MAX = 9_999;

/**
 * Product display metadata — prices are fixed per FRONTEND.md rule #2.
 * Mirrors `config.js::PRODUCT_CATALOG` on the backend.
 */
const PRODUCT_DISPLAY: Record<
  ProductKey,
  { name: string; price: number; asset: string }
> = {
  croissant: {
    name: "Croissant",
    price: 4.75,
    asset: "/assets/products/croissant.svg",
  },
  cookie: { name: "Cookie", price: 2.5, asset: "/assets/products/cookie.svg" },
  bagel: { name: "Bagel", price: 3.0, asset: "/assets/products/bagel.svg" },
  sandwich: {
    name: "Sandwich",
    price: 8.75,
    asset: "/assets/products/sandwich.svg",
  },
  coffee: { name: "Coffee", price: 4.0, asset: "/assets/products/coffee.svg" },
  matcha: {
    name: "Matcha",
    price: 6.25,
    asset: "/assets/products/matcha.svg",
  },
};

interface StationMeta {
  id: StationId;
  title: string;
  subtitle: string;
  /** Placeholder sprite for sous chefs at this station. */
  chefSprite: string;
  products: [ProductKey, ProductKey];
}

const STATIONS: StationMeta[] = [
  {
    id: "bakery",
    title: "Bakery",
    subtitle: "Oven",
    chefSprite: "/assets/chefs/french-f.svg",
    products: ["croissant", "cookie"],
  },
  {
    id: "deli",
    title: "Deli",
    subtitle: "Meat Slicer",
    chefSprite: "/assets/chefs/italian-m.svg",
    products: ["bagel", "sandwich"],
  },
  {
    id: "barista",
    title: "Barista",
    subtitle: "Espresso Machine",
    chefSprite: "/assets/chefs/japanese-f.svg",
    products: ["coffee", "matcha"],
  },
];

/** Compact inline sous-chef indicator for a station card header. */
function StationChefBadge({
  count,
  sprite,
}: {
  count: number;
  sprite: string;
}) {
  const visible = Math.min(count, 3);
  const overflow = Math.max(0, count - visible);
  if (count <= 0) {
    return <span className="station-card__badge-empty">No chefs</span>;
  }
  return (
    <div className="station-card__badge" aria-label={`${count} sous chefs`}>
      {Array.from({ length: visible }).map((_, i) => (
        <img
          key={i}
          className="station-card__badge-sprite"
          src={sprite}
          alt=""
          aria-hidden
        />
      ))}
      {overflow > 0 && (
        <span className="station-card__badge-overflow">+{overflow}</span>
      )}
    </div>
  );
}

interface ProductTileProps {
  product: ProductKey;
  qty: number;
  price: number;
  isOnMenu: boolean;
  isBase: boolean;
  /** Apr 28 2026 — true when the team has paid to unlock this product. */
  isUnlocked: boolean;
  /** Cost (USD) to unlock this product right now. 0 when already unlocked. */
  unlockCost: number;
  /** True when this product can't be unlocked yet (insufficient budget). */
  cannotAfford: boolean;
  /** True while a purchase callable is in flight (disables all unlock buttons). */
  unlockPending: boolean;
  /** Trigger the purchaseProduct callable for this product. */
  onUnlock: () => void;
  unitCost: number;
  onQtyChange: (next: number) => void;
  onPriceChange: (next: number) => void;
  /** FE-9 — lock quantity + menu toggle once the round is submitted. */
  readOnly?: boolean;
  /** POST-01 — disable the price stepper when the viewer is not Finance. */
  priceDisabled: boolean;
}
function ProductTile({
  product,
  qty,
  price,
  isOnMenu,
  isBase,
  isUnlocked,
  unlockCost,
  cannotAfford,
  unlockPending,
  onUnlock,
  unitCost,
  onQtyChange,
  onPriceChange,
  readOnly = false,
  priceDisabled,
}: ProductTileProps) {
  const d = PRODUCT_DISPLAY[product];
  // Two states for a non-base tile (K-04 collapsed the old "+ Add"
  // intermediate step — unlock now auto-enables the product on the menu):
  //   1. unlocked → full controls (qty stepper, price)
  //   2. locked   → "Unlock for $X" button (purchase first)
  const showLockedState = !isBase && !isUnlocked;
  return (
    <div
      className={`product-tile${
        !isOnMenu ? " product-tile--locked" : ""
      }${showLockedState ? " product-tile--paywall" : ""}${
        readOnly ? " product-tile--readonly" : ""
      }`}
    >
      <img className="product-tile__image" src={d.asset} alt={d.name} />
      <div className="product-tile__info">
        <span className="product-tile__name">{d.name}</span>
        <span className="product-tile__price">
          Base: ${d.price.toFixed(2)}
        </span>
      </div>
      {isOnMenu ? (
        <div className="product-tile__controls">
          {readOnly ? (
            <span
              className="product-tile__stepper product-tile__stepper--readonly"
              aria-label={`${d.name} submitted quantity`}
            >
              <span className="product-tile__step-value product-tile__step-value--static">
                {qty}
              </span>
            </span>
          ) : (
            <div
              className="product-tile__stepper"
              role="group"
              aria-label={`${d.name} quantity`}
            >
              <button
                type="button"
                className="product-tile__step-btn"
                onClick={() => onQtyChange(Math.max(0, qty - 1))}
                disabled={qty <= 0}
                aria-label={`Decrease ${d.name}`}
              >
                −
              </button>
              {/* B-02 (2026-04-29): cap product quantity at 9,999 per Q17.
                  Red error class flips on at the cap; the + button still
                  hard-stops at the max so a typed-in value over-cap is
                  what triggers the error chip. */}
              <input
                type="number"
                className={`product-tile__step-value${
                  qty > BAKERY_QTY_MAX
                    ? " product-tile__step-value--error"
                    : ""
                }`}
                min={0}
                max={BAKERY_QTY_MAX}
                step={1}
                value={qty}
                onChange={(e) =>
                  onQtyChange(parseInt(e.target.value, 10) || 0)
                }
                aria-invalid={qty > BAKERY_QTY_MAX ? "true" : undefined}
                aria-label={`${d.name} quantity`}
              />
              <button
                type="button"
                className="product-tile__step-btn"
                onClick={() => onQtyChange(qty + 1)}
                disabled={qty >= BAKERY_QTY_MAX}
                aria-label={`Increase ${d.name}`}
              >
                +
              </button>
            </div>
          )}
          {qty > BAKERY_QTY_MAX && (
            <p className="product-tile__qty-error" role="alert">
              Max 9,999 units per product.
            </p>
          )}
          <span className="product-tile__unit-cost">Cost: ${unitCost.toFixed(2)} / unit</span>
          <PriceInput
            value={price}
            onChange={onPriceChange}
            cfg={PRICE_ZONES[product]}
            disabled={readOnly || priceDisabled}
          />
          {/* K-04 (2026-04-29): once unlocked, products stay on menu. The
              "Remove" (✕) and "+ Add" affordances were removed alongside
              the SET_TEAM_UNLOCKS auto-enable in GameContext. Users dial
              quantity to 0 to skip a product instead of toggling it off.*/}
        </div>
      ) : readOnly ? (
        <span className="product-tile__muted">
          {showLockedState ? "🔒 Locked" : "Off menu"}
        </span>
      ) : showLockedState ? (
        <button
          type="button"
          className="product-tile__unlock"
          onClick={onUnlock}
          disabled={unlockPending || cannotAfford}
          title={
            cannotAfford
              ? `Need $${unlockCost.toLocaleString()} to unlock ${d.name}.`
              : `Unlock ${d.name} for your team for $${unlockCost.toLocaleString()}.`
          }
          aria-label={`Unlock ${d.name} for $${unlockCost}`}
        >
          🔒 Unlock — ${unlockCost.toLocaleString()}
        </button>
      ) : null}
    </div>
  );
}

/**
 * FE-9 — parent (GamePage) passes `readOnly` so that the entire menu grid
 * becomes inert once the player submits or the phase advances past Decide.
 * Prices remain visible; only the interactive controls disappear.
 */
export interface BakeryViewProps {
  readOnly?: boolean;
}

export function BakeryView({ readOnly = false }: BakeryViewProps) {
  const {
    player,
    teamName,
    currentRound,
    totalRounds,
    pendingDecision,
    role,
    teamRoleAssignments,
    config,
    gameId,
    unlockedProducts,
    budgetCurrent,
    equipmentGrade,
  } = useGame();
  const dispatch = useGameDispatch();
  // FE-I15: let any teammate edit prices when no one on the team
  // holds finance.
  const canEditPrices = roleOwnsPricing(role, teamRoleAssignments);

  // Apr 28 2026 — station-unlock state. Flat cost per unlock, sourced from
  // `/games/{gameId}/config/params.productUnlockCost` with a static fallback
  // until the config-doc listener has hydrated.
  const unlockCost = config?.productUnlockCost ?? DEFAULT_PRODUCT_UNLOCK_COST;
  const [unlockPending, setUnlockPending] = useState<ProductKey | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const purchaseUnlock = async (product: ProductKey) => {
    if (!gameId || readOnly || unlockPending) return;
    setUnlockPending(product);
    setUnlockError(null);
    try {
      const fn = httpsCallable(functions, "purchaseProduct");
      await fn({ gameId, product });
      // The team-doc listener picks up the new unlockedProducts /
      // unlocksPurchased and SET_TEAM_UNLOCKS handles the menu/quantity
      // normalization. We additionally tally the spend on the local
      // receipt so the player sees "Miscellaneous" jump by $unlockCost
      // — `unlocksPurchased` is game-cumulative, so we can't derive a
      // round-scoped total from it.
      dispatch({ type: "ADD_MISC_SPEND", payload: { amount: unlockCost } });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not unlock product.";
      setUnlockError(message);
    } finally {
      setUnlockPending(null);
    }
  };

  const { staffCounts } = pendingDecision;
  const chefCountForStation = (s: StationId): number => {
    if (s === "bakery") return staffCounts.bakerySousChefs;
    if (s === "deli") return staffCounts.deliSousChefs;
    return staffCounts.baristaSousChefs;
  };

  const setQty = (product: ProductKey, value: number) => {
    if (readOnly) return;
    const clamped = Math.max(0, Math.floor(value) || 0);
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: { quantities: { [product]: clamped } },
    });
  };

  const setPrice = (product: ProductKey, value: number) => {
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: { productPrices: { [product]: value } },
    });
  };

  const bakeryCost = totalProductCost(
    pendingDecision.menu,
    pendingDecision.quantities,
    config,
  );
  const staffCost = totalStaffCost(pendingDecision.staffCounts, config);
  const miscSpent = pendingDecision.miscSpent;
  // Include equipment upgrade cost in the committed total when toggled,
  // so the grand total matches what the backend will deduct.
  const equipmentUpgradeCost =
    pendingDecision.equipmentUpgradePurchased && equipmentGrade
      ? (tierUpgradeCost(equipmentGrade) ?? 0)
      : 0;
  const totalCommitted = bakeryCost + staffCost + miscSpent + equipmentUpgradeCost;
  const unitCost = config?.unitCostPerProduct ?? 1;
  const cannotAfford = budgetCurrent !== null && budgetCurrent < unlockCost;
  const lockedRemaining = STATIONS.flatMap((s) => s.products).filter(
    (p) => !BASE_MENU.includes(p) && !unlockedProducts.includes(p),
  );

  return (
    <div className={`bakery-view${readOnly ? " bakery-view--readonly" : ""}`}>
      <div className="bakery-view__sign">
        <h2 className="bakery-view__name">
          {teamName ?? player?.bakeryName ?? "My Bakery"}
          {readOnly && (
            <span
              className="tab__badge tab__badge--submitted bakery-view__badge"
              aria-label="Menu submitted"
            >
              Submitted
            </span>
          )}
        </h2>
        <span className="bakery-view__round">
          Round {currentRound} of {totalRounds}
        </span>
      </div>

      <div className="bakery-view__stations" role="list">
        {STATIONS.map((station) => {
          const chefCount = chefCountForStation(station.id);
          return (
            <section
              key={station.id}
              className={`station-card station-card--${station.id}`}
              role="listitem"
              aria-label={`${station.title} station`}
            >
              <header className="station-card__header">
                <div className="station-card__heading">
                  <span className="station-card__title">{station.title}</span>
                  <span className="station-card__subtitle">
                    {station.subtitle}
                  </span>
                </div>
                <StationChefBadge
                  count={chefCount}
                  sprite={station.chefSprite}
                />
              </header>

              <div className="station-card__products">
                {station.products.map((product) => {
                  const isBase = BASE_MENU.includes(product);
                  const isUnlocked =
                    isBase || unlockedProducts.includes(product);
                  return (
                    <ProductTile
                      key={product}
                      product={product}
                      qty={pendingDecision.quantities[product] ?? 0}
                      price={pendingDecision.productPrices[product] ?? 0}
                      isOnMenu={pendingDecision.menu[product]}
                      isBase={isBase}
                      isUnlocked={isUnlocked}
                      unlockCost={unlockCost}
                      cannotAfford={cannotAfford}
                      unlockPending={unlockPending !== null}
                      onUnlock={() => void purchaseUnlock(product)}
                      unitCost={unitCost}
                      onQtyChange={(n) => setQty(product, n)}
                      onPriceChange={(n) => setPrice(product, n)}
                      readOnly={readOnly}
                      priceDisabled={!canEditPrices}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {!readOnly && lockedRemaining.length > 0 && (
        <div className="bakery-view__unlock-banner" role="status">
          <span className="bakery-view__unlock-banner-icon" aria-hidden>
            🔒
          </span>
          <div className="bakery-view__unlock-banner-text">
            <strong>
              {lockedRemaining.length} product
              {lockedRemaining.length === 1 ? "" : "s"} still locked.
            </strong>{" "}
            Each unlock costs <strong>${unlockCost.toLocaleString()}</strong>.
          </div>
        </div>
      )}
      {unlockError && (
        <p className="bakery-view__unlock-error" role="alert">
          {unlockError}
        </p>
      )}

      <div className="bakery-view__total-committed">
        <div className="bakery-view__total-committed-row bakery-view__total-committed-row--total">
          <span>Total Committed This Round</span>
          <strong>${totalCommitted.toFixed(2)}</strong>
        </div>
        <div className="bakery-view__total-committed-row">
          <span>· Staff</span>
          <strong>${staffCost.toFixed(2)}</strong>
        </div>
        <div className="bakery-view__total-committed-row">
          <span>· Bakery</span>
          <strong>${bakeryCost.toFixed(2)}</strong>
        </div>
        <div className="bakery-view__total-committed-row">
          <span>· Miscellaneous</span>
          <strong>${miscSpent.toFixed(2)}</strong>
        </div>
        {equipmentUpgradeCost > 0 && (
          <div className="bakery-view__total-committed-row">
            <span>· Equipment Upgrade</span>
            <strong>${equipmentUpgradeCost.toLocaleString()}</strong>
          </div>
        )}
      </div>
    </div>
  );
}
