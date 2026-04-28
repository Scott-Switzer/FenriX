"""How much of the predictive signal lives in variables a *student in the game*
can actually influence vs. variables fixed at bakery setup?

Game decisions a student makes during a round:
  - menu (which products to offer)
  - production qty per product
  - sous chef count + assignments
  - ad bids per channel
  - chef bids
  - prices (POST-01 only)

Game-fixed context (NOT a student decision):
  - location_type, traffic_zone, bakery_size, parking_spots, storefront_color
  - chef_count_total, head_chef_tradition, chef_skill_level, sous_chef_count
    (some of these can be modified via auctions/hires; bakery base is fixed)
  - equipment_grade, cleanliness_grade
  - owner_years_experience
  - yelp_review_count

Dataset-only (no clear game equivalent or only context):
  - customer_satisfaction, yelp_review_count

Compare cross-validated R^2:
  M_full         — all features
  M_controllable — only price/qty/ad_spend/primary_ad_channel
  M_fixed        — only the fixed-context features
  M_chef         — only chef-related (game has chef auction)

If M_controllable beats naive by a lot AND adds a meaningful chunk over M_fixed,
the dataset is teaching students something they can act on. If M_fixed dominates,
students are just learning "what bakery you started in determines your fate."

Outputs: analysis/output/04_controllable_signal.txt
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import KFold, cross_val_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

HERE = Path(__file__).resolve().parents[1]
DATA = HERE / "data"
OUT = HERE / "output"


def load(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df.drop(columns=[c for c in df.columns if "educator use only" in c.lower()])
    df = df.drop(columns=[c for c in df.columns if c.startswith("Unnamed") and df[c].isna().all()])
    return df


CONTROLLABLE = (
    [f"price_{p}" for p in ["croissant", "muffin", "cookie", "coffee", "matcha", "sandwich", "sourdough", "banana_bread"]]
    + [f"qty_{p}" for p in ["croissant", "muffin", "cookie", "coffee", "matcha", "sandwich", "sourdough", "banana_bread"]]
    + [f"ad_spend_{c}" for c in ["billboard", "radio", "instagram", "tiktok", "newspaper"]]
    + ["primary_ad_channel"]
)

CHEF = [
    "chef_count_total", "head_chef_tradition", "chef_skill_level",
    "sous_chef_count", "maintenance_staff_count",
]

FIXED_CONTEXT = [
    "location_type", "bakery_size", "storefront_color", "traffic_zone",
    "parking_spots", "owner_years_experience", "equipment_grade", "cleanliness_grade",
]

QUALITY_OUTCOMES = ["customer_satisfaction", "yelp_review_count"]

# Game-relevant product subset (overlap of dataset and game products)
GAME_PRODUCTS = ["croissant", "cookie", "coffee", "matcha", "sandwich"]
DATASET_ONLY_PRODUCTS = ["muffin", "sourdough", "banana_bread"]
GAME_ONLY_PRODUCTS = ["bagel"]
GAME_AD_CHANNELS = ["billboard", "radio", "newspaper"]
DATASET_ONLY_AD_CHANNELS = ["instagram", "tiktok"]
GAME_ONLY_AD_CHANNELS = ["TV"]


def cv_r2(df: pd.DataFrame, y: np.ndarray, cols: list[str]) -> tuple[float, float]:
    if not cols:
        return float("nan"), float("nan")
    feat = df[cols]
    cat_cols = [c for c in cols if not pd.api.types.is_numeric_dtype(feat[c])]
    num_cols = [c for c in cols if pd.api.types.is_numeric_dtype(feat[c])]
    pre = ColumnTransformer([
        ("num", StandardScaler(), num_cols),
        ("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols),
    ])
    mdl = Pipeline([("pre", pre), ("est", LinearRegression())])
    cv = KFold(n_splits=5, shuffle=True, random_state=42)
    r2 = cross_val_score(mdl, feat, y, scoring="r2", cv=cv, n_jobs=-1)
    rmse = np.sqrt(-cross_val_score(mdl, feat, y, scoring="neg_mean_squared_error", cv=cv, n_jobs=-1))
    return float(r2.mean()), float(rmse.mean())


def main() -> None:
    df = load(DATA / "professor_clean.csv")
    y = df["total_units_sold"].values

    lines: list[str] = []
    lines.append(f"n={len(df)}; y_mean={y.mean():.1f}; y_std={y.std():.1f}")
    naive_rmse = float(y.std())
    lines.append(f"naive RMSE = {naive_rmse:.1f} (predict mean)\n")

    feature_sets = {
        "ALL features (excl bakery_id, target)": [c for c in df.columns if c not in ("bakery_id", "total_units_sold")],
        "Controllable (price+qty+ad_spend+ad_channel)": CONTROLLABLE,
        "Fixed context (location, traffic, size, equip, etc.)": FIXED_CONTEXT,
        "Chef-related (count, tradition, skill, sous, maint)": CHEF,
        "Quality outcomes (cust_sat + yelp)": QUALITY_OUTCOMES,
        "GAME-overlapping products only (qty, 5 products)": [f"qty_{p}" for p in GAME_PRODUCTS],
        "GAME-overlapping products only (price, 5 products)": [f"price_{p}" for p in GAME_PRODUCTS],
        "GAME-overlapping ad channels only (3 channels)": [f"ad_spend_{c}" for c in GAME_AD_CHANNELS],
        "Dataset-only products (qty: muffin/sourdough/banana_bread)": [f"qty_{p}" for p in DATASET_ONLY_PRODUCTS],
        "Dataset-only ad channels (instagram + tiktok)": [f"ad_spend_{c}" for c in DATASET_ONLY_AD_CHANNELS],
    }

    lines.append(f"{'feature set':60s}  {'CV R^2':>8s}  {'CV RMSE':>10s}  {'lift_vs_naive':>14s}  {'n_features':>10s}")
    for name, cols in feature_sets.items():
        r2, rmse = cv_r2(df, y, cols)
        if np.isnan(r2):
            lines.append(f"  {name:60s}  {'—':>8s}  {'—':>10s}  {'—':>14s}  {len(cols):>10d}")
        else:
            lift = (naive_rmse - rmse) / naive_rmse * 100
            lines.append(f"  {name:60s}  {r2:8.3f}  {rmse:10.1f}  {lift:13.1f}%  {len(cols):>10d}")

    # Add: all controllable that ALSO exists in game
    game_aligned = (
        [f"qty_{p}" for p in GAME_PRODUCTS]
        + [f"price_{p}" for p in GAME_PRODUCTS]
        + [f"ad_spend_{c}" for c in GAME_AD_CHANNELS]
        + ["primary_ad_channel"]
    )
    r2, rmse = cv_r2(df, y, game_aligned)
    lift = (naive_rmse - rmse) / naive_rmse * 100
    lines.append("")
    lines.append("--- GAME-ALIGNED features only (drop dataset-only products & channels) ---")
    lines.append(f"  features: {game_aligned}")
    lines.append(f"  CV R^2={r2:.3f}  CV RMSE={rmse:.1f}  lift_vs_naive={lift:.1f}%  n_features={len(game_aligned)}")

    # Game-aligned controllable + fixed context that DOES translate (chef skill exists in game via auction)
    game_aligned_plus_chef = game_aligned + ["chef_skill_level", "head_chef_tradition", "sous_chef_count"]
    r2, rmse = cv_r2(df, y, game_aligned_plus_chef)
    lift = (naive_rmse - rmse) / naive_rmse * 100
    lines.append("")
    lines.append("--- GAME-ALIGNED + chef skill/tradition/sous_count (translates via auction) ---")
    lines.append(f"  CV R^2={r2:.3f}  CV RMSE={rmse:.1f}  lift_vs_naive={lift:.1f}%  n_features={len(game_aligned_plus_chef)}")

    # Compute residual signal: how much R^2 is added by controllable on top of fixed?
    r2_fixed, _ = cv_r2(df, y, FIXED_CONTEXT)
    r2_fixed_plus_ctrl, _ = cv_r2(df, y, FIXED_CONTEXT + CONTROLLABLE)
    lines.append("")
    lines.append("--- Marginal value of controllable on top of fixed context ---")
    lines.append(f"  R^2 fixed-only           = {r2_fixed:.3f}")
    lines.append(f"  R^2 fixed + controllable = {r2_fixed_plus_ctrl:.3f}")
    lines.append(f"  marginal R^2 from control = {r2_fixed_plus_ctrl - r2_fixed:+.3f}")

    text = "\n".join(lines)
    (OUT / "04_controllable_signal.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
