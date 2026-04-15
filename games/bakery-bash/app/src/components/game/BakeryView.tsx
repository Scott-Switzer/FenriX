import { useGame } from "../../contexts/GameContext";

const SHELF_ITEMS = [
  { src: "/assets/products/croissant.svg", alt: "Croissant" },
  { src: "/assets/products/cookie.svg", alt: "Cookie" },
  { src: "/assets/products/bagel.svg", alt: "Bagel" },
  { src: "/assets/products/sandwich.svg", alt: "Sandwich" },
  { src: "/assets/products/latte.svg", alt: "Latte" },
  { src: "/assets/products/matcha-latte.svg", alt: "Matcha Latte" },
];

export function BakeryView() {
  const { player, currentRound, totalRounds } = useGame();

  return (
    <div className="bakery-view">
      <div className="bakery-view__storefront">
        <div className="bakery-view__sign">
          <h2 className="bakery-view__name">
            {player?.bakeryName ?? "My Bakery"}
          </h2>
          <span className="bakery-view__round">
            Round {currentRound} of {totalRounds}
          </span>
        </div>

        <div className="bakery-view__window">
          <div className="bakery-view__display">
            <div className="bakery-view__shelf">
              {SHELF_ITEMS.slice(0, 3).map((item) => (
                <img
                  key={item.alt}
                  className="bakery-view__shelf-item"
                  src={item.src}
                  alt={item.alt}
                />
              ))}
            </div>
            <div className="bakery-view__shelf">
              {SHELF_ITEMS.slice(3).map((item) => (
                <img
                  key={item.alt}
                  className="bakery-view__shelf-item"
                  src={item.src}
                  alt={item.alt}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="bakery-view__floor">
          <div className="bakery-view__counter" />
        </div>
      </div>

      <p className="bakery-view__hint">
        Use the tabs on the right to set your menu quantities, hire staff, and
        place auction bids. Hit <strong>Submit</strong> when ready.
      </p>
    </div>
  );
}
