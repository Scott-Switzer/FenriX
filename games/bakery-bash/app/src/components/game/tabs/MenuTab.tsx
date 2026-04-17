import { useGame, useGameDispatch } from "../../../contexts/GameContext";
import {
  BASE_MENU,
  PRODUCT_KEYS,
  type ProductKey,
} from "../../../types/game";

/**
 * Product display metadata. Prices are fixed per FRONTEND.md rule #2 — no
 * price inputs, read-only labels only. Matches backend
 * `config.js::PRODUCT_CATALOG`.
 */
const PRODUCT_DISPLAY: Record<ProductKey, { name: string; price: number }> = {
  croissant: { name: "Croissant", price: 4.75 },
  cookie: { name: "Cookie", price: 2.5 },
  bagel: { name: "Bagel", price: 3.0 },
  sandwich: { name: "Sandwich", price: 8.75 },
  coffee: { name: "Coffee", price: 4.0 },
  matcha: { name: "Matcha", price: 6.25 },
};

export function MenuTab() {
  const { pendingDecision } = useGame();
  const dispatch = useGameDispatch();

  const setQty = (product: ProductKey, value: number) => {
    const clamped = Math.max(0, Math.floor(value) || 0);
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: { quantities: { [product]: clamped } },
    });
  };

  const toggleMenu = (product: ProductKey, checked: boolean) => {
    if (BASE_MENU.includes(product)) return;
    dispatch({
      type: "UPDATE_PENDING_DECISION",
      payload: {
        menu: { [product]: checked },
        ...(checked ? {} : { quantities: { [product]: 0 } }),
      },
    });
  };

  const totalCost = PRODUCT_KEYS.reduce((sum, product) => {
    if (!pendingDecision.menu[product]) return sum;
    const qty = pendingDecision.quantities[product] ?? 0;
    return sum + PRODUCT_DISPLAY[product].price * qty;
  }, 0);

  return (
    <div className="menu-tab">
      <h3 className="sidebar-tab__title">Menu</h3>
      <p className="sidebar-tab__hint">Set how many of each item to stock.</p>

      <div className="menu-tab__list">
        {PRODUCT_KEYS.map((product) => {
          const display = PRODUCT_DISPLAY[product];
          const isBase = BASE_MENU.includes(product);
          const isOnMenu = pendingDecision.menu[product];
          return (
            <div
              key={product}
              className={`menu-tab__item ${
                !isOnMenu ? "menu-tab__item--locked" : ""
              }`}
            >
              <div className="menu-tab__item-info">
                <span className="menu-tab__item-name">{display.name}</span>
                <span className="menu-tab__item-price">
                  ${display.price.toFixed(2)}
                </span>
              </div>
              {isOnMenu ? (
                <input
                  type="number"
                  className="menu-tab__qty-input"
                  placeholder="0"
                  min={0}
                  step={1}
                  value={pendingDecision.quantities[product] ?? 0}
                  onChange={(e) =>
                    setQty(product, parseInt(e.target.value, 10) || 0)
                  }
                />
              ) : (
                <label className="menu-tab__unlock">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={(e) => toggleMenu(product, e.target.checked)}
                    disabled={isBase}
                  />
                  <span className="menu-tab__locked-badge">Add</span>
                </label>
              )}
            </div>
          );
        })}
      </div>

      <div className="menu-tab__total">
        Stock Revenue (max): <strong>${totalCost.toFixed(2)}</strong>
      </div>
    </div>
  );
}
