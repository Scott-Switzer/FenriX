"""Dataset profile for breadwork_dataset (professor clean + student sample).

Outputs:
  analysis/output/01_profile.txt      — human-readable profile
  analysis/output/01_profile.json     — machine-readable summary

Run:
  python3 analysis/scripts/01_profile.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


HERE = Path(__file__).resolve().parents[1]
DATA = HERE / "data"
OUT = HERE / "output"
OUT.mkdir(exist_ok=True)


def load_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    # professor file has a trailing watermark column; drop empties
    drop_cols = [c for c in df.columns if "educator use only" in c.lower()]
    if drop_cols:
        df = df.drop(columns=drop_cols)
    # also drop unnamed all-null columns from trailing commas
    for c in list(df.columns):
        if c.startswith("Unnamed") and df[c].isna().all():
            df = df.drop(columns=[c])
    return df


def column_kind(name: str, s: pd.Series) -> str:
    if name == "bakery_id":
        return "id"
    if name.startswith("price_"):
        return "price"
    if name.startswith("qty_"):
        return "qty"
    if name.startswith("ad_spend_"):
        return "ad_spend"
    if name == "primary_ad_channel":
        return "categorical"
    if pd.api.types.is_numeric_dtype(s):
        return "numeric"
    return "categorical"


def numeric_summary(s: pd.Series) -> dict:
    s = pd.to_numeric(s, errors="coerce")
    nn = s.dropna()
    if len(nn) == 0:
        return {"n": 0}
    return {
        "n": int(len(nn)),
        "nulls": int(s.isna().sum()),
        "min": float(nn.min()),
        "p1": float(nn.quantile(0.01)),
        "p5": float(nn.quantile(0.05)),
        "p25": float(nn.quantile(0.25)),
        "p50": float(nn.quantile(0.50)),
        "p75": float(nn.quantile(0.75)),
        "p95": float(nn.quantile(0.95)),
        "p99": float(nn.quantile(0.99)),
        "max": float(nn.max()),
        "mean": float(nn.mean()),
        "std": float(nn.std()),
        "zeros": int((nn == 0).sum()),
        "negatives": int((nn < 0).sum()),
        "skew": float(nn.skew()),
        "kurtosis": float(nn.kurtosis()),
    }


def categorical_summary(s: pd.Series) -> dict:
    vc = s.astype(str).value_counts(dropna=False)
    return {
        "n": int(s.notna().sum()),
        "nulls": int(s.isna().sum()),
        "distinct": int(vc.shape[0]),
        "top": [(str(k), int(v)) for k, v in vc.head(10).items()],
        "bottom": [(str(k), int(v)) for k, v in vc.tail(5).items()],
    }


def profile(df: pd.DataFrame, label: str) -> dict:
    rows, cols = df.shape
    summary: dict = {
        "label": label,
        "rows": int(rows),
        "cols": int(cols),
        "columns": [],
        "duplicates": {
            "bakery_id": int(df["bakery_id"].duplicated().sum()) if "bakery_id" in df.columns else None,
            "full_row": int(df.duplicated().sum()),
        },
    }
    for c in df.columns:
        s = df[c]
        kind = column_kind(c, s)
        entry: dict = {"name": c, "dtype": str(s.dtype), "kind": kind}
        if kind == "id":
            entry["distinct"] = int(s.nunique())
        elif kind in ("categorical",):
            entry.update(categorical_summary(s))
        else:
            entry.update(numeric_summary(s))
        summary["columns"].append(entry)
    return summary


def render_text(summary: dict) -> str:
    lines = []
    lines.append(f"=== {summary['label']} ===")
    lines.append(f"rows={summary['rows']}  cols={summary['cols']}")
    lines.append(
        f"duplicates: bakery_id={summary['duplicates']['bakery_id']}  full_row={summary['duplicates']['full_row']}"
    )
    lines.append("")
    by_kind: dict[str, list] = {}
    for c in summary["columns"]:
        by_kind.setdefault(c["kind"], []).append(c)
    for kind in ["id", "categorical", "numeric", "price", "qty", "ad_spend"]:
        cols = by_kind.get(kind, [])
        if not cols:
            continue
        lines.append(f"--- {kind} ({len(cols)}) ---")
        for c in cols:
            if kind == "id":
                lines.append(f"  {c['name']}: distinct={c['distinct']}")
                continue
            if kind == "categorical":
                top = ", ".join(f"{k}={v}" for k, v in c["top"][:8])
                lines.append(
                    f"  {c['name']}: distinct={c['distinct']}  nulls={c['nulls']}"
                )
                lines.append(f"    top: {top}")
                continue
            lines.append(
                f"  {c['name']}: n={c['n']} nulls={c['nulls']} "
                f"min={c['min']:.2f} p25={c['p25']:.2f} p50={c['p50']:.2f} "
                f"p75={c['p75']:.2f} max={c['max']:.2f} mean={c['mean']:.2f} "
                f"std={c['std']:.2f} zeros={c['zeros']} skew={c['skew']:.2f}"
            )
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    out_text: list[str] = []
    out_json: dict = {}
    for label, fname in [("professor_clean", "professor_clean.csv"), ("student_sample", "student_sample.csv")]:
        df = load_csv(DATA / fname)
        summary = profile(df, label)
        out_text.append(render_text(summary))
        out_json[label] = summary
    (OUT / "01_profile.txt").write_text("\n".join(out_text))
    (OUT / "01_profile.json").write_text(json.dumps(out_json, indent=2))
    print((OUT / "01_profile.txt").read_text())


if __name__ == "__main__":
    main()
