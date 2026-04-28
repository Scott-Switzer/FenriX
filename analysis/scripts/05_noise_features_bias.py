"""How much does including 'noise' features (vars present in the dataset but
absent in the game) bias a student's coefficient estimates on the variables
that DO transfer to gameplay?

Per the professor: location_type, traffic_zone, bakery_size are not in the game.
Per inspection of game source: ad_spend_instagram, ad_spend_tiktok, qty_muffin,
qty_sourdough, qty_banana_bread (and matching prices), yelp_review_count, and
several bakery-survey context vars (storefront_color, parking_spots,
owner_years_experience, equipment_grade) also don't translate.

A student who naively fits OLS on the full dataset learns coefficients on the
*game-aligned* features (price_coffee, qty_cookie, ad_spend_billboard, etc.)
that are partial effects controlling for the noise features. In the game, the
noise features either don't exist or are constant across teams. The question:
do the partial-effect coefficients match the bivariate (game-relevant) effects?
If they do, students are safe. If they don't, the dataset is misleading.

We compare coefficients for 'overlap' features (game-aligned controllable +
chef-related + satisfaction) under two specifications:
  Model FULL : trained with all 37 features (incl. noise)
  Model LEAN : trained with only the overlap features

Outputs: analysis/output/05_noise_features_bias.txt
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


# Per professor: location_type, traffic_zone, bakery_size are noise (no game equivalent)
# Per inspection of games/bakery-bash/backend/functions/modules/config.js:
#   - Game products: coffee, croissant, bagel, cookie, sandwich, matcha
#   - Game ad channels: TV, Billboard, Radio, Newspaper
#   - No yelp, no parking, no owner_years_experience, no equipment_grade
#   - cleanliness_grade exists in code (burglary mechanic) but minor
NOISE_FEATURES = (
    # confirmed noise per professor
    ["location_type", "traffic_zone", "bakery_size"]
    # very likely noise (no game mechanic visible in config.js)
    + ["storefront_color", "parking_spots", "owner_years_experience", "equipment_grade", "yelp_review_count"]
    # dataset-only products (game has no muffin, sourdough, banana_bread)
    + [f"price_{p}" for p in ["muffin", "sourdough", "banana_bread"]]
    + [f"qty_{p}" for p in ["muffin", "sourdough", "banana_bread"]]
    # dataset-only ad channels (game has no instagram or tiktok)
    + ["ad_spend_instagram", "ad_spend_tiktok"]
    # maintenance_staff_count weakly maps to burglary mechanic — count as borderline noise
    + ["maintenance_staff_count"]
)

# Features that map to game decisions students CAN influence in-round
OVERLAP_FEATURES = (
    [f"price_{p}" for p in ["croissant", "cookie", "coffee", "matcha", "sandwich"]]
    + [f"qty_{p}" for p in ["croissant", "cookie", "coffee", "matcha", "sandwich"]]
    + [f"ad_spend_{c}" for c in ["billboard", "radio", "newspaper"]]
    + ["primary_ad_channel"]
    + ["chef_count_total", "head_chef_tradition", "chef_skill_level", "sous_chef_count"]
    + ["customer_satisfaction"]   # observable per round, not a decision but a proxy outcome
    + ["cleanliness_grade"]        # weak game tie via burglary
)


def load(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df.drop(columns=[c for c in df.columns if "educator use only" in c.lower()])
    df = df.drop(columns=[c for c in df.columns if c.startswith("Unnamed") and df[c].isna().all()])
    return df


def fit_get_coefs(df: pd.DataFrame, y: np.ndarray, cols: list[str]) -> tuple[pd.Series, float, float]:
    cat_cols = [c for c in cols if not pd.api.types.is_numeric_dtype(df[c])]
    num_cols = [c for c in cols if pd.api.types.is_numeric_dtype(df[c])]
    pre = ColumnTransformer([
        ("num", StandardScaler(), num_cols),
        ("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols),
    ])
    mdl = Pipeline([("pre", pre), ("est", LinearRegression())])
    mdl.fit(df[cols], y)
    fnames = (
        num_cols
        + list(mdl.named_steps["pre"].named_transformers_["cat"].get_feature_names_out(cat_cols))
    )
    coefs = pd.Series(mdl.named_steps["est"].coef_, index=fnames)

    cv = KFold(n_splits=5, shuffle=True, random_state=42)
    r2 = float(cross_val_score(mdl, df[cols], y, scoring="r2", cv=cv, n_jobs=-1).mean())
    rmse = float(np.sqrt(-cross_val_score(mdl, df[cols], y, scoring="neg_mean_squared_error", cv=cv, n_jobs=-1).mean()))
    return coefs, r2, rmse


def main() -> None:
    df = load(DATA / "professor_clean.csv")
    y = df["total_units_sold"].values

    all_features = [c for c in df.columns if c not in ("bakery_id", "total_units_sold")]
    overlap_present = [c for c in OVERLAP_FEATURES if c in df.columns]
    noise_present = [c for c in NOISE_FEATURES if c in df.columns]

    lines: list[str] = []
    lines.append(f"n={len(df)} rows; y_mean={y.mean():.1f}; y_std={y.std():.1f}")
    lines.append(f"all features: {len(all_features)}")
    lines.append(f"overlap (game-aligned) features: {len(overlap_present)}")
    lines.append(f"noise (dataset-only) features: {len(noise_present)}")
    missing = set(all_features) - set(overlap_present) - set(noise_present)
    if missing:
        lines.append(f"WARNING — features not classified as overlap or noise: {sorted(missing)}")
    lines.append("")

    # Two model specifications
    coefs_full, r2_full, rmse_full = fit_get_coefs(df, y, all_features)
    coefs_lean, r2_lean, rmse_lean = fit_get_coefs(df, y, overlap_present)

    lines.append("--- CV performance ---")
    lines.append(f"  FULL  (incl. noise): R^2={r2_full:.3f}  RMSE={rmse_full:.1f}")
    lines.append(f"  LEAN  (overlap only): R^2={r2_lean:.3f}  RMSE={rmse_lean:.1f}")
    lines.append("")
    lines.append("Interpretation: if FULL is much better, dataset noise vars are real predictors")
    lines.append("but they do NOT exist in the game — so a student model trained on FULL will")
    lines.append("over-predict in dataset and under-predict in game (lower in-game R^2 ceiling).")
    lines.append("")

    # Compare coefficients on overlapping (game-relevant) features
    common = sorted(set(coefs_full.index) & set(coefs_lean.index))
    rows = []
    for c in common:
        full = float(coefs_full.get(c, 0.0))
        lean = float(coefs_lean.get(c, 0.0))
        diff = full - lean
        rel = (abs(diff) / abs(lean) * 100) if abs(lean) > 1e-6 else float("nan")
        rows.append((c, full, lean, diff, rel))
    cmp_df = pd.DataFrame(rows, columns=["feature", "coef_full", "coef_lean", "diff", "pct_diff"])
    cmp_df["abs_lean"] = cmp_df["coef_lean"].abs()
    cmp_df = cmp_df.sort_values("abs_lean", ascending=False)

    lines.append("--- Coefficient comparison on overlap features (sorted by |coef_lean|) ---")
    lines.append("(Standardized numerics. Reading: how much does including the noise vars change")
    lines.append(" the partial-effect estimate for a feature that DOES exist in the game?)")
    lines.append(f"  {'feature':40s}  {'coef_FULL':>10s}  {'coef_LEAN':>10s}  {'diff':>8s}  {'%diff':>8s}")
    for _, row in cmp_df.head(30).iterrows():
        pct = f"{row['pct_diff']:7.1f}%" if not np.isnan(row["pct_diff"]) else "    nan"
        lines.append(
            f"  {row['feature']:40s}  {row['coef_full']:+10.2f}  {row['coef_lean']:+10.2f}  "
            f"{row['diff']:+8.2f}  {pct}"
        )

    # Summary stats for bias
    big_swings = cmp_df[(cmp_df["abs_lean"] > 5) & (cmp_df["pct_diff"] > 25)].shape[0]
    sign_flips = cmp_df[
        (cmp_df["abs_lean"] > 1) & (np.sign(cmp_df["coef_full"]) != np.sign(cmp_df["coef_lean"]))
    ].shape[0]
    lines.append("")
    lines.append("--- Bias summary ---")
    lines.append(f"  game-relevant features with |coef|>5 AND >25% relative change: {big_swings}")
    lines.append(f"  game-relevant features with sign flips between FULL and LEAN: {sign_flips}")
    lines.append("")
    if big_swings > 0 or sign_flips > 0:
        lines.append("  → Including dataset-only noise vars BIASES estimates of game-relevant features.")
        lines.append("  → A student who trains on FULL and applies in-game will get systematically")
        lines.append("    wrong coefficients on price / qty / ad_spend / chef variables.")
    else:
        lines.append("  → Coefficients on game-relevant features are robust to including noise vars.")
        lines.append("  → Students can train on FULL and the controllable-feature effects will transfer.")

    text = "\n".join(lines)
    (OUT / "05_noise_features_bias.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
