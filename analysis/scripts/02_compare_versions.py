"""Compare professor vs student CSVs to figure out exactly how they differ.

Hypothesis from profile: distributions are nearly identical, only yelp_review_count
shows real variation. So student version may be a permutation of same rows + noise
on a few columns + reshuffled bakery_ids -- not an independent sample.

Confirms by:
  1. Sorting both by every column except bakery_id, comparing row-by-row.
  2. Trying to find the bakery_id mapping by content match.
  3. Computing per-column noise: identical values? small perturbation? full resample?

Outputs: analysis/output/02_compare_versions.txt
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parents[1]
DATA = HERE / "data"
OUT = HERE / "output"


def load(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df.drop(columns=[c for c in df.columns if "educator use only" in c.lower()])
    df = df.drop(columns=[c for c in df.columns if c.startswith("Unnamed") and df[c].isna().all()])
    return df


def main() -> None:
    prof = load(DATA / "professor_clean.csv")
    stu = load(DATA / "student_sample.csv")
    lines: list[str] = []

    lines.append(f"prof shape: {prof.shape}; student shape: {stu.shape}")
    lines.append(f"columns equal: {list(prof.columns) == list(stu.columns)}")

    feature_cols = [c for c in prof.columns if c != "bakery_id"]

    # 1. Try: are the rows identical when sorted by all features?
    p_sorted = prof[feature_cols].sort_values(feature_cols).reset_index(drop=True)
    s_sorted = stu[feature_cols].sort_values(feature_cols).reset_index(drop=True)
    full_match = p_sorted.equals(s_sorted)
    lines.append(f"\nWhen sorted by all features (excluding bakery_id), rows identical? {full_match}")

    # 2. Per-column: count exact-match values across the two datasets (after sorting each column independently)
    lines.append("\n--- Per-column comparison (sorted independently) ---")
    lines.append(f"{'column':30s}  {'identical':10s}  {'sum_abs_diff':14s}  {'max_abs_diff':12s}  {'corr_after_sort':16s}")
    diffs = {}
    for c in feature_cols:
        p_col = prof[c].sort_values().reset_index(drop=True)
        s_col = stu[c].sort_values().reset_index(drop=True)
        if pd.api.types.is_numeric_dtype(p_col):
            same = bool((p_col == s_col).all())
            d = (p_col - s_col).abs()
            sad = float(d.sum())
            mad = float(d.max())
            corr = float(p_col.corr(s_col)) if p_col.std() > 0 and s_col.std() > 0 else float("nan")
            diffs[c] = (same, sad, mad, corr)
            lines.append(f"  {c:30s}  {str(same):10s}  {sad:14.4f}  {mad:12.4f}  {corr:16.6f}")
        else:
            same = bool((p_col.astype(str).values == s_col.astype(str).values).all())
            diffs[c] = (same, None, None, None)
            lines.append(f"  {c:30s}  {str(same):10s}  {'—':14s}  {'—':12s}  {'—':16s}")

    # 3. Try to find a row-mapping: for each prof row, is there a matching student row?
    #    Use a hash on all non-id columns.
    def rowhash(df: pd.DataFrame) -> pd.Series:
        return df[feature_cols].astype(str).agg("|".join, axis=1)

    p_hash = rowhash(prof)
    s_hash = rowhash(stu)
    p_set = set(p_hash)
    s_set = set(s_hash)
    inter = p_set & s_set
    lines.append(f"\nRow-hash overlap: {len(inter)}/{len(p_hash)} prof rows have an identical row in student")

    # 4. If overlap < total, exclude likely-noised columns and retry
    likely_noisy = [c for c in feature_cols if isinstance(diffs[c][0], bool) and diffs[c][0] is False]
    lines.append(f"\nLikely-noised columns (sorted-not-equal): {likely_noisy}")
    if likely_noisy:
        stable_cols = [c for c in feature_cols if c not in likely_noisy]
        p_hash2 = prof[stable_cols].astype(str).agg("|".join, axis=1)
        s_hash2 = stu[stable_cols].astype(str).agg("|".join, axis=1)
        inter2 = set(p_hash2) & set(s_hash2)
        lines.append(f"Row-hash overlap excluding noised cols: {len(inter2)}/{len(p_hash2)}")

        # 5. For each likely-noised numeric column, compute paired noise after matching by stable columns
        if len(inter2) >= len(p_hash2) * 0.9:
            # Build a deterministic match: for each prof row, find first student row with same stable hash
            s_idx_by_hash: dict[str, list[int]] = {}
            for i, h in enumerate(s_hash2):
                s_idx_by_hash.setdefault(h, []).append(i)
            pairs: list[tuple[int, int]] = []
            used: set[int] = set()
            for i, h in enumerate(p_hash2):
                bucket = s_idx_by_hash.get(h, [])
                for j in bucket:
                    if j in used:
                        continue
                    pairs.append((i, j))
                    used.add(j)
                    break
            lines.append(f"Matched {len(pairs)} pairs via stable-column join")
            if pairs:
                p_idx = [p for p, _ in pairs]
                s_idx = [s for _, s in pairs]
                lines.append("\n--- Noise on noisy columns (paired) ---")
                for c in likely_noisy:
                    if pd.api.types.is_numeric_dtype(prof[c]):
                        d = prof.loc[p_idx, c].values - stu.loc[s_idx, c].values
                        lines.append(
                            f"  {c}: mean={np.mean(d):.4f}  std={np.std(d):.4f}  "
                            f"min={np.min(d):.4f}  max={np.max(d):.4f}  "
                            f"abs_mean={np.mean(np.abs(d)):.4f}  zeros={int(np.sum(d == 0))}/{len(d)}"
                        )
                    else:
                        same_count = int(np.sum(
                            prof.loc[p_idx, c].astype(str).values
                            == stu.loc[s_idx, c].astype(str).values
                        ))
                        lines.append(f"  {c}: matching values {same_count}/{len(p_idx)}")

    # 6. bakery_id sanity
    lines.append(f"\nProf bakery_id range: {prof['bakery_id'].min()}–{prof['bakery_id'].max()} (n_distinct={prof['bakery_id'].nunique()})")
    lines.append(f"Student bakery_id range: {stu['bakery_id'].min()}–{stu['bakery_id'].max()} (n_distinct={stu['bakery_id'].nunique()})")
    common_ids = set(prof['bakery_id']) & set(stu['bakery_id'])
    lines.append(f"Common bakery_ids between the two: {len(common_ids)}")

    text = "\n".join(lines)
    (OUT / "02_compare_versions.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
