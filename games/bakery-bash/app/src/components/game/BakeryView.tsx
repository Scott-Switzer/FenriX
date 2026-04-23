import { useGame, useGameDispatch } from "../../contexts/GameContext";
import {
  BASE_MENU,
  roleOwnsPricing,
  type ProductKey,
  type StationId,
} from "../../types/game";

import { PRICE_ZONES } from "../../lib/pricing";
import { PriceInput } from "./PriceInput";

const UNIT_COST = 0.5;

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
  onQtyChange: (next: number) => void;
  onPriceChange: (next: number) => void;
  onToggle: (next: boolean) => void;
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
  onQtyChange,
  onPriceChange,
  onToggle,
  readOnly = false,
  priceDisabled,
}: ProductTileProps) {
  const d = PRODUCT_DISPLAY[product];
  return (
    <div
      className={`product-tile${!isOnMenu ? " product-tile--locked" : ""}${
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
              <input
                type="number"
                className="product-tile__step-value"
                min={0}
                step={1}
                value={qty}
                onChange={(e) =>
                  onQtyChange(parseInt(e.target.value, 10) || 0)
                }
                aria-label={`${d.name} quantity`}
              />
              <button
                type="button"
                className="product-tile__step-btn"
                onClick={() => onQtyChange(qty + 1)}
                aria-label={`Increase ${d.name}`}
              >
                +
              </button>
            </div>
          )}
          <span className="product-tile__unit-cost">Cost: ${UNIT_COST.toFixed(2)} / unit</span>
          <PriceInput
            value={price}
            onChange={onPriceChange}
            cfg={PRICE_ZONES[product]}
            disabled={readOnly || priceDisabled}
          />
          {!isBase && !readOnly && (
            <button
              type="button"
              className="product-tile__remove"
              onClick={() => onToggle(false)}
              aria-label={`Remove ${d.name} from menu`}
              title={`Remove ${d.name} from menu`}
            >
              ✕
            </button>
          )}
        </div>
      ) : readOnly ? (
        <span className="product-tile__muted">Off menu</span>
      ) : (
        <button
          type="button"
          className="product-tile__add"
          onClick={() => onToggle(true)}
          disabled={isBase}
        >
          + Add
        </button>
      )}
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
  } = useGame();
  const dispatch = useGameDispatch();
  // FE-I15: let any teammate edit prices when no one on the team
  // holds finance.
  const canEditPrices = roleOwnsPricing(role, teamRoleAssignments);

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

  const toggleMenu = (product: ProductKey, checked: boolean) => {
    if (readOnly) return;
    if (BASE_MENU.includes(product)) return;
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: {
        menu: { [product]: checked },
        ...(checked ? {} : { quantities: { [product]: 0 } }),
      },
    });
  };

  const allProducts = STATIONS.flatMap((s) => s.products);
  const totalCommitted = allProducts
    .filter((item) => pendingDecision.menu[item])
    .reduce((sum, item) => sum + (pendingDecision.quantities[item] ?? 0) * UNIT_COST, 0);

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
                {station.products.map((product) => (
                  <ProductTile
                    key={product}
                    product={product}
                    qty={pendingDecision.quantities[product] ?? 0}
                    price={pendingDecision.productPrices[product] ?? 0}
                    isOnMenu={pendingDecision.menu[product]}
                    isBase={BASE_MENU.includes(product)}
                    onQtyChange={(n) => setQty(product, n)}
                    onPriceChange={(n) => setPrice(product, n)}
                    onToggle={(next) => toggleMenu(product, next)}
                    readOnly={readOnly}
                    priceDisabled={!canEditPrices}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <div className="bakery-view__total-committed">
        Total Committed This Round: <strong>${totalCommitted.toFixed(2)}</strong>
      </div>
    </div>
  );
}
