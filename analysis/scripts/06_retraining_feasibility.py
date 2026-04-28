"""Can students recover game-truth via in-round re-training, given that the
game exposes ~12 teams × N observations per round?

Setup
-----
We treat the dataset's overlap-feature OLS as a stand-in for the 'game DGP':
the controllable features (price, qty, ad_spend on overlapping channels, chef
attrs, satisfaction, cleanliness) drive a linear-ish target. We sample held-out
rows from the dataset to simulate 'in-game observations' and train four
strategies on increasing observation budgets:

  S1  Naive student   — trains OLS on dataset with ALL features (incl noise)
                        applies in-game with noise features set to the
                        student-team's known constants (location_type='suburban',
                        traffic_zone='medium', bakery_size='medium' — picked as
                        modes; could be any single constant in the game).
                        NEVER updates from in-game data.
  S2  Smart student   — trains OLS on dataset with only OVERLAP features (no
                        noise). NEVER updates from in-game data.
  S3  Online updater  — starts as S2, then appends in-game observations and
                        refits each round (uses the same OVERLAP feature spec).
  S4  Pure in-game    — ignores dataset entirely, fits OLS only on accumulated
                        in-game observations.

We sweep observation budget = teams × rounds, with teams ∈ {6, 12, 24} and
rounds 1..10. Track out-of-sample RMSE on a held-out 'game test set' (rows
NOT used as observations).

The answer to 'is re-training feasible' is whether S3 (or S4) converges to
better in-game performance than S1/S2 within the actual game budget
(5 rounds × ~12 teams = 60 observations).

Outputs:
  analysis/output/06_retraining_curves.csv   — per-strategy x rounds RMSE table
  analysis/output/06_retraining_feasibility.txt — narrative summary
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_squared_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

HERE = Path(__file__).resolve().parents[1]
DATA = HERE / "data"
OUT = HERE / "output"

OVERLAP = (
    [f"price_{p}" for p in ["croissant", "cookie", "coffee", "matcha", "sandwich"]]
    + [f"qty_{p}" for p in ["croissant", "cookie", "coffee", "matcha", "sandwich"]]
    + [f"ad_spend_{c}" for c in ["billboard", "radio", "newspaper"]]
    + ["primary_ad_channel"]
    + ["chef_count_total", "head_chef_tradition", "chef_skill_level", "sous_chef_count"]
    + ["customer_satisfaction", "cleanliness_grade"]
)

NOISE = [
    "location_type", "traffic_zone", "bakery_size", "storefront_color",
    "parking_spots", "owner_years_experience", "equipment_grade", "yelp_review_count",
    "maintenance_staff_count",
    "price_muffin", "price_sourdough", "price_banana_bread",
    "qty_muffin", "qty_sourdough", "qty_banana_bread",
    "ad_spend_instagram", "ad_spend_tiktok",
]


def load(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df.drop(columns=[c for c in df.columns if "educator use only" in c.lower()])
    df = df.drop(columns=[c for c in df.columns if c.startswith("Unnamed") and df[c].isna().all()])
    return df


def make_pipeline(cols: list[str], df_for_types: pd.DataFrame) -> Pipeline:
    cat_cols = [c for c in cols if not pd.api.types.is_numeric_dtype(df_for_types[c])]
    num_cols = [c for c in cols if pd.api.types.is_numeric_dtype(df_for_types[c])]
    pre = ColumnTransformer([
        ("num", StandardScaler(), num_cols),
        ("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols),
    ])
    return Pipeline([("pre", pre), ("est", LinearRegression())])


def make_game_observations(test_df: pd.DataFrame) -> pd.DataFrame:
    """Strip out 'noise' features by collapsing them to a single constant.

    The student team in the game has fixed bakery setup (suburban, medium, etc.)
    and the dataset-only products/channels don't exist. We simulate that by
    setting all noise columns to a constant (modal value) for every test row.
    The OVERLAP columns vary normally (these are the in-game decisions and
    observable outcomes).
    """
    g = test_df.copy()
    for c in NOISE:
        if c not in g.columns:
            continue
        if pd.api.types.is_numeric_dtype(g[c]):
            g[c] = g[c].mean()
        else:
            g[c] = g[c].mode().iloc[0]
    return g


def main() -> None:
    df = load(DATA / "professor_clean.csv")
    target = "total_units_sold"
    rng = np.random.default_rng(42)

    # Reserve a 'game test set' of 200 rows that NEVER goes into training/observation
    all_idx = np.arange(len(df))
    rng.shuffle(all_idx)
    test_idx = all_idx[:200]
    pool_idx = all_idx[200:]
    test_df = df.iloc[test_idx].reset_index(drop=True)
    pool_df = df.iloc[pool_idx].reset_index(drop=True)

    # The "game version" of the test set has noise features collapsed to constants
    test_game = make_game_observations(test_df)
    y_test = test_df[target].values

    # The pool is 528 rows; training uses the first 288 and the last 240
    # are reserved as a separate slice for sampled 'in-game observations'
    # (max 24 teams × 10 rounds).
    obs_pool_idx = list(range(len(pool_df) - 240, len(pool_df)))
    train_pool_idx = list(range(len(pool_df) - 240))
    train_df = pool_df.iloc[train_pool_idx].reset_index(drop=True)
    obs_pool_df = pool_df.iloc[obs_pool_idx].reset_index(drop=True)
    # In-game observations come from a 'game version' as well — controllable features
    # are real but the noise features are constants (because in the game they are constants).
    obs_pool_game = make_game_observations(obs_pool_df)

    overlap_present = [c for c in OVERLAP if c in df.columns]
    all_features = [c for c in df.columns if c not in ("bakery_id", target)]

    # Train static models
    full_pipe = make_pipeline(all_features, df)
    full_pipe.fit(train_df[all_features], train_df[target].values)

    lean_pipe = make_pipeline(overlap_present, df)
    lean_pipe.fit(train_df[overlap_present], train_df[target].values)

    # Predict on game-version test set
    pred_S1 = full_pipe.predict(test_game[all_features])
    pred_S2 = lean_pipe.predict(test_game[overlap_present])
    rmse_S1 = float(np.sqrt(mean_squared_error(y_test, pred_S1)))
    rmse_S2 = float(np.sqrt(mean_squared_error(y_test, pred_S2)))

    teams_options = [6, 12, 24]
    rounds = list(range(1, 11))
    rows = []

    naive_baseline_rmse = float(np.sqrt(np.mean((y_test - y_test.mean()) ** 2)))

    for n_teams in teams_options:
        # randomly draw an "observation order" from obs_pool_game so that successive
        # rounds give us additional teams' data
        order = rng.permutation(len(obs_pool_game))
        for r in rounds:
            n_obs = n_teams * r
            if n_obs > len(obs_pool_game):
                continue
            obs_idx = order[:n_obs]
            obs_chunk = obs_pool_game.iloc[obs_idx]

            # S3: online updater = LEAN pipeline retrained on dataset_train + obs_chunk
            combo_X = pd.concat([train_df[overlap_present], obs_chunk[overlap_present]], ignore_index=True)
            combo_y = np.concatenate([train_df[target].values, obs_chunk[target].values])
            online_pipe = make_pipeline(overlap_present, df)
            online_pipe.fit(combo_X, combo_y)
            pred_S3 = online_pipe.predict(test_game[overlap_present])
            rmse_S3 = float(np.sqrt(mean_squared_error(y_test, pred_S3)))

            # S4: pure in-game = LEAN pipeline trained ONLY on obs_chunk
            # (need at least n > num features to fit; OLS will fail silently if singular)
            n_required = max(20, len(overlap_present))
            if n_obs < n_required:
                rmse_S4 = float("nan")
            else:
                pure_pipe = make_pipeline(overlap_present, df)
                pure_pipe.fit(obs_chunk[overlap_present], obs_chunk[target].values)
                pred_S4 = pure_pipe.predict(test_game[overlap_present])
                rmse_S4 = float(np.sqrt(mean_squared_error(y_test, pred_S4)))

            rows.append({
                "n_teams": n_teams,
                "round": r,
                "n_obs": n_obs,
                "S1_naive_rmse": rmse_S1,    # constant across rounds
                "S2_smart_rmse": rmse_S2,    # constant across rounds
                "S3_online_rmse": rmse_S3,
                "S4_pure_ingame_rmse": rmse_S4,
                "naive_mean_rmse": naive_baseline_rmse,
            })

    out_df = pd.DataFrame(rows)
    out_df.to_csv(OUT / "06_retraining_curves.csv", index=False)

    # Narrative
    lines: list[str] = []
    lines.append("--- Setup ---")
    lines.append(f"Dataset training rows: {len(train_df)}")
    lines.append(f"Game observation pool: {len(obs_pool_df)} (sampled per round)")
    lines.append(f"Held-out test set:    {len(test_df)} (game-version: noise cols collapsed to constants)")
    lines.append(f"Naive 'predict mean' RMSE on test: {naive_baseline_rmse:.1f}")
    lines.append("")
    lines.append("--- Static strategies (no in-game updates) ---")
    lines.append(f"  S1  Naive (all dataset features incl noise):    RMSE = {rmse_S1:.1f}")
    lines.append(f"  S2  Smart  (overlap-only dataset model):        RMSE = {rmse_S2:.1f}")
    lines.append("")
    lines.append("--- Re-training curves: RMSE on in-game test set ---")
    lines.append("(headers: t=teams; r=rounds; obs=observations; S3=online updater; S4=pure in-game)")
    lines.append("")
    for n_teams in teams_options:
        lines.append(f"  n_teams = {n_teams}")
        sub = out_df[out_df["n_teams"] == n_teams]
        lines.append(f"    {'r':>2s}  {'obs':>4s}  {'S3 online':>10s}  {'S4 pure':>10s}  ({'vs S2':>8s}, {'vs S1':>8s})")
        for _, row in sub.iterrows():
            s4 = f"{row['S4_pure_ingame_rmse']:>10.1f}" if not np.isnan(row["S4_pure_ingame_rmse"]) else f"{'(nan)':>10s}"
            vs_s2 = f"{(row['S3_online_rmse'] - rmse_S2):+8.1f}"
            vs_s1 = f"{(row['S3_online_rmse'] - rmse_S1):+8.1f}"
            lines.append(
                f"    {int(row['round']):2d}  {int(row['n_obs']):4d}  "
                f"{row['S3_online_rmse']:>10.1f}  {s4}  ({vs_s2}, {vs_s1})"
            )
        lines.append("")

    # Highlight the actual game scenario: 5 rounds × 12 teams = 60 obs
    target_row = out_df[(out_df["n_teams"] == 12) & (out_df["round"] == 5)]
    if not target_row.empty:
        r = target_row.iloc[0]
        lines.append("--- Actual game scenario: 12 teams × 5 rounds = 60 observations ---")
        lines.append(f"  S1 naive (all features, no update):        RMSE = {rmse_S1:.1f}")
        lines.append(f"  S2 smart (overlap dataset, no update):     RMSE = {rmse_S2:.1f}")
        lines.append(f"  S3 online (smart + 60 in-game obs):        RMSE = {r['S3_online_rmse']:.1f}")
        s4 = r['S4_pure_ingame_rmse']
        s4_str = f"{s4:.1f}" if not np.isnan(s4) else "(could not fit; underspecified)"
        lines.append(f"  S4 pure in-game (60 obs, no dataset):      RMSE = {s4_str}")
        lines.append(f"  Naive 'predict mean':                      RMSE = {naive_baseline_rmse:.1f}")
        lines.append("")
        lines.append("Interpretation:")
        if r["S3_online_rmse"] < rmse_S2:
            lines.append("  → Online updates with 60 in-game obs improve over the dataset-only smart model.")
        else:
            lines.append("  → Online updates with 60 in-game obs do NOT improve over dataset-only.")
        if r["S3_online_rmse"] < rmse_S1:
            lines.append("  → Online updates outperform the naive (all-features) approach.")
        else:
            lines.append("  → Online updates do NOT outperform the naive (all-features) approach.")
        if not np.isnan(s4) and s4 < rmse_S2:
            lines.append("  → Pure in-game learner (no dataset) beats dataset-trained: dataset is misleading.")
        elif not np.isnan(s4):
            lines.append("  → Pure in-game learner is worse than dataset-trained: dataset prior helps.")

    text = "\n".join(lines)
    (OUT / "06_retraining_feasibility.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
