"""Test whether the dataset has exploitable signal for predicting total_units_sold.

Compares:
  - Naive baseline (mean prediction)
  - Linear regression (MGSC 220 student tier)
  - Random Forest (MGSC 310 student tier)
  - Gradient Boosting (best modeling effort)

Reports out-of-sample R^2, RMSE, and feature importance. The questions:
  1. Is signal strong enough that a model beats naive?
  2. Is signal so dominated by one feature that strategy is trivial?
  3. Are the right kinds of features (decisions students could plausibly make in-game) the strong predictors?

Outputs: analysis/output/03_signal_strength.txt
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
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


def main() -> None:
    df = load(DATA / "professor_clean.csv")
    target = "total_units_sold"
    y = df[target].values

    # Drop id and target. Keep everything else as features.
    feat_df = df.drop(columns=["bakery_id", target])
    cat_cols = [c for c in feat_df.columns if not pd.api.types.is_numeric_dtype(feat_df[c])]
    num_cols = [c for c in feat_df.columns if pd.api.types.is_numeric_dtype(feat_df[c])]

    lines: list[str] = []
    lines.append(f"n={len(df)}  target={target}")
    lines.append(f"y stats: mean={y.mean():.1f} std={y.std():.1f} min={y.min()} max={y.max()}")
    lines.append(f"num features: {len(num_cols)}; cat features: {len(cat_cols)}")
    lines.append("")

    # Baseline: predict mean
    naive_rmse = float(np.sqrt(np.mean((y - y.mean()) ** 2)))
    naive_mae = float(np.mean(np.abs(y - y.mean())))
    lines.append("--- Naive baseline (predict mean) ---")
    lines.append(f"  RMSE={naive_rmse:.1f}  MAE={naive_mae:.1f}  R^2=0.0 (by definition)")
    lines.append("")

    # Pipeline preprocessing: standardize numeric, one-hot categorical
    pre = ColumnTransformer(
        transformers=[
            ("num", StandardScaler(), num_cols),
            ("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols),
        ]
    )

    cv = KFold(n_splits=5, shuffle=True, random_state=42)

    models = {
        "Linear (220-tier)": Pipeline([("pre", pre), ("est", LinearRegression())]),
        "RandomForest (310-tier)": Pipeline(
            [("pre", pre), ("est", RandomForestRegressor(n_estimators=300, random_state=42, n_jobs=-1))]
        ),
        "GradientBoost (best)": Pipeline(
            [("pre", pre), ("est", GradientBoostingRegressor(n_estimators=300, random_state=42))]
        ),
    }

    lines.append("--- 5-fold CV (out-of-sample) ---")
    lines.append(f"  {'model':30s}  {'CV R^2':>8s}  {'CV RMSE':>10s}  {'CV MAE':>10s}  {'lift_vs_naive':>14s}")
    for name, mdl in models.items():
        r2 = cross_val_score(mdl, feat_df, y, scoring="r2", cv=cv, n_jobs=-1)
        rmse = np.sqrt(-cross_val_score(mdl, feat_df, y, scoring="neg_mean_squared_error", cv=cv, n_jobs=-1))
        mae = -cross_val_score(mdl, feat_df, y, scoring="neg_mean_absolute_error", cv=cv, n_jobs=-1)
        lift = (naive_rmse - rmse.mean()) / naive_rmse * 100
        lines.append(
            f"  {name:30s}  {r2.mean():8.3f}  {rmse.mean():10.1f}  {mae.mean():10.1f}  {lift:13.1f}%"
        )
    lines.append("")

    # Feature importance via Random Forest (full-fit)
    rf = Pipeline([("pre", pre), ("est", RandomForestRegressor(n_estimators=500, random_state=42, n_jobs=-1))])
    rf.fit(feat_df, y)
    feature_names = (
        num_cols
        + list(rf.named_steps["pre"].named_transformers_["cat"].get_feature_names_out(cat_cols))
    )
    importances = rf.named_steps["est"].feature_importances_
    imp_df = pd.DataFrame({"feature": feature_names, "importance": importances}).sort_values(
        "importance", ascending=False
    )

    lines.append("--- Random Forest feature importance (top 25) ---")
    for _, row in imp_df.head(25).iterrows():
        bar = "#" * int(row["importance"] * 200)
        lines.append(f"  {row['feature']:35s}  {row['importance']:.4f}  {bar}")
    lines.append("")

    # Concentration: how much of importance is in top-1, top-3, top-5?
    cum = imp_df["importance"].cumsum().values
    lines.append("--- Importance concentration ---")
    lines.append(f"  top-1 feature: {cum[0]*100:.1f}% of total importance")
    lines.append(f"  top-3 features: {cum[2]*100:.1f}%")
    lines.append(f"  top-5 features: {cum[4]*100:.1f}%")
    lines.append(f"  top-10 features: {cum[9]*100:.1f}%")
    lines.append("")

    # Group importance by semantic family
    def family(fname: str) -> str:
        if fname.startswith("price_"):
            return "price"
        if fname.startswith("qty_"):
            return "qty"
        if fname.startswith("ad_spend_"):
            return "ad_spend"
        if fname.startswith("primary_ad_channel"):
            return "ad_channel_chosen"
        for prefix in ["location_type", "bakery_size", "storefront_color", "traffic_zone",
                       "head_chef_tradition", "chef_skill_level", "equipment_grade",
                       "cleanliness_grade"]:
            if fname.startswith(prefix):
                return prefix
        return fname

    imp_df["family"] = imp_df["feature"].apply(family)
    fam = imp_df.groupby("family")["importance"].sum().sort_values(ascending=False)
    lines.append("--- Importance grouped by feature family ---")
    for f, v in fam.items():
        bar = "#" * int(v * 200)
        lines.append(f"  {f:30s}  {v*100:6.2f}%  {bar}")
    lines.append("")

    # Linear coefficients (sign + magnitude) for interpretability
    lr = Pipeline([("pre", pre), ("est", LinearRegression())])
    lr.fit(feat_df, y)
    coefs = lr.named_steps["est"].coef_
    feature_names_lr = (
        num_cols
        + list(lr.named_steps["pre"].named_transformers_["cat"].get_feature_names_out(cat_cols))
    )
    coef_df = pd.DataFrame({"feature": feature_names_lr, "coef": coefs})
    coef_df["abs_coef"] = coef_df["coef"].abs()
    coef_df = coef_df.sort_values("abs_coef", ascending=False)
    lines.append("--- Linear regression coefficients (top 25 by |coef|) ---")
    lines.append("  (note: numeric features are standardized so coefs are comparable per-feature-stddev)")
    for _, row in coef_df.head(25).iterrows():
        sign = "+" if row["coef"] >= 0 else "-"
        lines.append(f"  {row['feature']:35s}  {sign}{abs(row['coef']):.2f}")
    lines.append("")

    text = "\n".join(lines)
    (OUT / "03_signal_strength.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
