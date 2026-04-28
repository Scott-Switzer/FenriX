# BreadWorks Dataset — Fitness for Bakery Bash (v2)

Validation of `breadwork_dataset.csv` (39 vars, 728 rows, target = `total_units_sold`)
against the Bakery Bash game's actual decision points and runtime telemetry.

Scripts in [`analysis/scripts/`](scripts/), raw outputs in [`analysis/output/`](output/).

> **Source data is not committed to this repo.** The `breadwork_dataset.csv`
> files and `BreadWorks_Data_Key.pdf` are watermarked "for educational use only
> and should not be distributed" by the publisher. The scripts read from
> `analysis/data/` (gitignored); to reproduce, drop your local copies of the
> two CSVs and the PDF there before running.

> **v2 reframe (after professor confirmation, 2026-04-27):**
> The dataset is intended for game strategy, and the vocabulary mismatches
> (bagel/muffin, TV/TikTok, dataset-only context features) are **intentional**:
> students are meant to encounter distribution shift and re-train during the
> 5-round game session. v1 of this report assumed the mismatches were bugs and
> recommended patching the game; v2 rewrites the recommendations around the
> two real obstacles to the intended pedagogy: the dataset's noise features
> *bias* coefficient estimates on game-relevant features, and the in-game
> telemetry path doesn't currently support practical re-training.

---

## TL;DR

**Three findings that determine whether the design works as intended:**

1. **Naive students are actively misled by the dataset, not just under-served.**
   Including the dataset's noise features (location, traffic, size, dataset-only
   products and channels, etc.) doesn't merely lower out-of-sample R² — it
   **flips the sign of 5 coefficients** on game-relevant features and shifts
   another 15 by more than 25%. A naive OLS student would learn that "billboard
   ads don't help" and "hiring chefs hurts revenue" from the FULL model;
   restricting to the LEAN (game-overlap-only) feature set says the opposite.
   This is the core teaching opportunity — and a stumbling block 220 students
   without feature-selection training will likely face. ([§3](#3-noise-features-actively-bias-coefficient-estimates))

2. **Re-training during the game is feasible in principle but tight in practice.**
   In a 12-teams × 5-rounds simulation (60 in-game observations, the actual
   game scenario), online updating improves RMSE by only ~1.5% over a smart
   dataset-only model. Pure in-game learning (no dataset prior) is *worse than
   naive* at 60 observations. The dataset prior carries most of the load; the
   "re-train as you go" lesson only meaningfully fires at ~150+ observations
   (≈12 teams × 12 rounds). ([§4](#4-re-training-feasibility-the-online-update-budget-is-too-small))

3. **The student CSV doesn't contain enough to actually re-train.** It exports
   27 outcome columns (`revenue_net`, `customer_count`, `customer_satisfaction`,
   per-product *units sold*, etc.) but **omits the team's own input decisions**
   (stocked quantities, resolved prices, ad/chef bid amounts, num products).
   Per-product satisfaction is also excluded by design. Students can't fit a
   regression `y ~ X` if `X` isn't in the file — they would have to manually
   log every decision per round to disk. **This is the single highest-leverage
   game-side fix.** ([§5](#5-the-telemetry-gap-students-cant-fit-y--x-without-x))

**The "different student versions" claim** (§6) doesn't hold either: the
professor file and the one student file we compared are bit-identical in 38/39
columns. Only `yelp_review_count` is noised. Students can functionally share
datasets. Whether this matters depends on whether the assignment is graded on
modeling craft (fine) or on dataset-specific results (problem).

**Verdict:** Dataset is well-suited *as a teaching prior* for the intended
"prior + online update" design — *if* (a) students are explicitly taught to
exclude noise features before training, (b) the student CSV exports their
decision inputs, and (c) the per-student noise generator is either fixed or
explicitly de-positioned. Without these, only the most disciplined students
will execute the design as intended.

---

## 1. Profile (unchanged from v1)

| Metric | Value |
|---|---|
| Rows | 728 |
| Columns | 39 (1 ID, 9 categorical, 8 prices, 8 quantities, 5 ad_spend, 1 ad_channel, plus 7 numeric/outcome) |
| Nulls | 0 anywhere |
| Duplicate `bakery_id`s | 0 |
| Duplicate full rows | 0 |
| Target `total_units_sold` | min 132, p50 570, max 1608, mean 600.8, σ 235.6, skew +0.99 |

Distributions look generated (skews near zero, prices and quantities sit in
plausible ranges). Several `ad_spend_*` columns have heavy zero-mass (21–55%
zeros) consistent with each bakery picking a `primary_ad_channel` and zeroing
out the others. The professor's CSV has a 40th watermark column titled
`this material is designated for educator use only and should not be distributed`
— empty in every row, would benefit from being moved out of the CSV.

Full profile: [analysis/output/01_profile.txt](output/01_profile.txt).

---

## 2. Signal strength (unchanged from v1)

5-fold cross-validation on `total_units_sold`:

| Model | CV R² | CV RMSE | Lift vs naive |
|---|---:|---:|---:|
| Naive (predict mean) | 0.000 | 235.6 | — |
| **Linear regression** (220 tier) | **0.672** | 133.7 | 43.2% |
| Random Forest (310 tier) | 0.509 | 164.1 | 30.4% |
| Gradient Boosting (best effort) | 0.606 | 146.7 | 37.7% |

Linear regression beats the tree models — the data is largely additive with
one-hot encoded categoricals. **MGSC 220 students with Excel will do well; MGSC
310 students who reach for ML must regularize or feature-engineer to beat OLS.**

No dominant feature: top-1 RF importance 13.3%, top-5 features 41.4%, top-10
57.0%. Healthy — students must consider multiple variables.

Family-level concentration (RF):
```
location_type           23.8%   ← noise per professor (no game equivalent)
qty                     19.7%   ← partial overlap (5/8 products in game)
price                   19.0%   ← partial overlap (5/8 products in game)
ad_spend                11.7%   ← partial overlap (3/5 channels in game)
traffic_zone             6.2%   ← noise per professor
bakery_size              4.6%   ← noise per professor
yelp_review_count        4.6%   ← noise (no game mechanic)
customer_satisfaction    1.7%   ← real game variable
```

Coefficient signs in the linear model are economically sensible (low traffic
hurts sales, master chefs help, higher coffee price reduces units sold).

Script: [scripts/03_signal_strength.py](scripts/03_signal_strength.py),
output: [output/03_signal_strength.txt](output/03_signal_strength.txt).

---

## 3. Noise features actively bias coefficient estimates

This is the most consequential v2 finding.

We classified the 37 features into two buckets:

- **NOISE (17 features)** — confirmed-noise per professor (`location_type`,
  `traffic_zone`, `bakery_size`), plus features with no game mechanic per
  inspection of `config.js` (`storefront_color`, `parking_spots`,
  `owner_years_experience`, `equipment_grade`, `yelp_review_count`,
  `maintenance_staff_count`), plus dataset-only products
  (`{price,qty}_{muffin,sourdough,banana_bread}`) and dataset-only ad channels
  (`ad_spend_{instagram,tiktok}`).
- **OVERLAP (20 features)** — features with a game equivalent the player can
  influence in-round: `{price,qty}_{croissant,cookie,coffee,matcha,sandwich}`,
  `ad_spend_{billboard,radio,newspaper}`, `primary_ad_channel`, all chef
  variables, `customer_satisfaction`, `cleanliness_grade`.

We fit two linear models on the same 728 rows:

| Model | Features | CV R² | CV RMSE |
|---|---|---:|---:|
| **FULL** | all 37 (incl. noise) | 0.672 | 134.0 |
| **LEAN** | 20 overlap-only | 0.204 | 209.3 |

Then compared the coefficient estimates on the 20 overlap features — *features
that exist in both models* — to see how including the noise features changes
the partial-effect estimates a student would learn.

**Result: 20 overlap features have ≥25% relative coefficient change between
FULL and LEAN, with 3 outright sign flips on game-meaningful magnitudes:**

| Feature | coef FULL | coef LEAN | flip? |
|---|---:|---:|:-:|
| `chef_count_total` | −1.91 | **+14.47** | ✅ |
| `ad_spend_billboard` | −2.66 | **+14.29** | ✅ |
| `sous_chef_count` | +1.69 | **−3.67** | ✅ |
| `chef_skill_level_intermediate` | −14.30 | −2.77 | (sign same, magnitude 5×) |
| `primary_ad_channel_tiktok` | +15.25 | **+91.87** | (6× magnitude) |

(The script's full count is 5 sign flips because its threshold is `|coef_lean|
> 1`; the 2 not shown are on coefficients below the table's top-30 cutoff and
small enough that a student modeling decisions wouldn't notice the wrong sign.)

Translation: a student running naive OLS on the dataset would conclude:
- "Hiring more chefs slightly *hurts* sales" (FULL coef −1.91)
- "Billboard ad spend slightly *hurts* sales" (FULL coef −2.66)
- "Sous chefs help" (FULL +1.69)

The LEAN model, restricted to features that translate to game decisions, says
the opposite on all three. **A naive student walks into the game with backwards
intuitions on chef hiring and billboard ads.**

This is the dataset's primary teaching opportunity — and a real obstacle for
220 students whose curriculum doesn't emphasize feature selection or
regularization. Without explicit guidance to drop the noise features, naive OLS
gives misleading game advice.

Script: [scripts/05_noise_features_bias.py](scripts/05_noise_features_bias.py),
output: [output/05_noise_features_bias.txt](output/05_noise_features_bias.txt).

---

## 4. Re-training feasibility: the online-update budget is too small

The intended design is "prior + online update during the game." We simulated
this to see how much in-game data is needed for the update to materially help.

### Setup

- Hold out 200 rows of the dataset as a **game test set** (with noise features
  collapsed to constants — proxy for "your bakery's setup is fixed").
- Use 288 rows as the **dataset training set** (what students fit before the
  game).
- Use 240 rows as a **game-observation pool** to draw `n_teams × n_rounds`
  observations from.

### Strategies

| Strategy | Description |
|---|---|
| **S1 Naive** | OLS on dataset, all 37 features (incl. noise), no in-game updates |
| **S2 Smart** | OLS on dataset, 20 overlap features only, no in-game updates |
| **S3 Online** | S2 + retrain after each round, appending in-game observations |
| **S4 Pure in-game** | OLS only on accumulated in-game observations (ignore dataset) |

### Result: 12 teams × 5 rounds = 60 observations (the live game)

| Strategy | Test RMSE | vs naive baseline |
|---|---:|---:|
| Naive baseline (predict mean) | 248.9 | 0% |
| **S1 naive student** (FULL features) | **265.3** | **−6.6%** (worse than mean!) |
| S2 smart student (LEAN, no update) | 229.9 | +7.6% |
| S3 online updater (LEAN + 60 obs) | 226.3 | +9.1% |
| S4 pure in-game learner (60 obs only) | 299.7 | −20.3% (much worse) |

Two stark observations:

1. **S1 (the naive default) is worse than predicting the mean.** Including
   noise features doesn't just fail to help in-game — it actively misleads.
2. **S3 vs S2 difference is tiny (~1.5%).** With 60 in-game observations, the
   "re-train during the game" lesson barely moves RMSE. The dataset prior is
   doing all the work.

### When does re-training start mattering?

| Scenario | n obs | S3 RMSE | S3 lift over S2 |
|---|---:|---:|---:|
| 12 teams × 5 rounds (live) | 60 | 226.3 | −1.5% |
| 12 teams × 10 rounds | 120 | 223.9 | −2.6% |
| 24 teams × 5 rounds | 120 | 220.1 | −4.2% |
| 24 teams × 8 rounds | 192 | 215.6 | −6.2% |
| 24 teams × 10 rounds | 240 | 217.5 | −5.4% |

Online updates start delivering meaningful lift around **150+ observations**.
The current 5-round × ~12-team design will leave most of the "re-train as you
go" lesson on the table.

### Caveat

This sim treats game observations as drawn from the dataset's DGP with the
noise features collapsed. In reality the game has its own DGP (from `config.js`
formulas) which may differ from the dataset's. The sim therefore:

- *Likely overstates* how well the dataset prior transfers (since real game
  bagel demand might be totally unlike dataset muffin demand).
- *Likely understates* the value of in-game updates for product-specific
  effects (since real game data on bagels would be the only signal at all).

Either way, with 60 observations, the dominant levers are: (a) drop noise
features before training, and (b) record decision inputs so you can fit at all
(see §5).

Script: [scripts/06_retraining_feasibility.py](scripts/06_retraining_feasibility.py),
output: [output/06_retraining_feasibility.txt](output/06_retraining_feasibility.txt),
data: [output/06_retraining_curves.csv](output/06_retraining_curves.csv).

---

## 5. The telemetry gap: students can't fit y ~ X without X

Audit of the student CSV export and Results screen at the time of analysis
(`CSV_COLUMNS` in
[`games/bakery-bash/app/src/components/game/RoundHeader.tsx`](../games/bakery-bash/app/src/components/game/RoundHeader.tsx)
and
[`games/bakery-bash/backend/functions/modules/csv-export.js`](../games/bakery-bash/backend/functions/modules/csv-export.js)).

> **Status update (post #110):** the decision-input columns called out as
> missing below — `num_products`, `price_*`, `*_qty_stocked` — were added to
> the student CSV in PR #110, exactly the "Concrete fix" this section
> recommends. The remaining gaps are `ad_type` and per-product
> `*_satisfaction_pct`.

### What the student CSV exports (27 columns at analysis time, one row per round)

```
round, revenue_net, revenue_gross, amount_borrowed, interest_charged,
customer_count, customer_satisfaction, chef_satisfaction_score,
cleanliness_pct, oven_health_pct, slicer_health_pct, espresso_health_pct,
bakery_sous_chef_count, deli_sous_chef_count, barista_sous_chef_count,
maintenance_guy_count,
ad_won, ad_paid, chef_won, chef_paid, sellout,
croissants_sold, cookies_sold, bagels_sold, sandwiches_sold,
coffees_sold, matchas_sold
```

### What the student CSV does NOT export (but the backend already computes)

| Missing column(s) | Why critical for re-training |
|---|---|
| `*_qty_stocked` (croissant, cookie, bagel, sandwich, coffee, matcha) | The **decision** the student made on production. Without this they can't model qty → satisfaction → revenue. |
| `price_*` (resolved per round) | The other primary **decision** under POST-01 dynamic pricing. Without this they can't fit price elasticity. |
| `num_products` | Number of menu items offered (bonus on revenue). |
| `ad_type` (the bid intent, not just the won) | Records what they **bid on**, not just what they won. |
| `*_satisfaction_pct` (per product) | Backend computes per-product satisfaction. Aggregate only is exported. Students can't diagnose which product drove an aggregate move. |
| `returningCustomersEarned` | Excluded by design per `BACKEND.md` line 414. |

The professor CSV (`csv-export.js` `includeProfessorColumns=true`, 49 columns)
**does** include all of these, plus `player_id`, `bakery_name`, `display_name`.

### Why this is the highest-leverage fix

A student who downloads the current CSV gets `revenue_net` and a bunch of
post-decision outcomes (satisfaction, customer count, chef satisfaction, etc.)
but no record of *what they did to produce those outcomes*. To re-train they
must:

1. Manually copy their submitted quantities, prices, and bid amounts to a
   notebook each round, then
2. Join that to the CSV by `round`, then
3. Fit `y ~ X`.

That's a lot of friction in a 5-minute decision window, especially for 220
students working in Excel. The technically-strongest students will manage; the
median student will give up and either (a) play by intuition or (b) keep using
their pre-game dataset model unchanged — which §3 just showed is misleading.

**Concrete fix:** add the 8 backend-already-computed decision-input columns to
the student CSV (`croissant_qty_stocked`, ..., `price_*`). One change in
`RoundHeader.tsx` `CSV_COLUMNS` list and the corresponding entries in
`serializeRow()`. No backend work required.

---

## 6. Per-student randomization (unchanged)

Comparing
`breadworks@frenzel/breadwork_dataset_tfrenzel.csv` to
`breadworks@dmassaro/breadwork_dataset.csv`:

- Same 728 `bakery_id`s in both files (BK1000–BK1727).
- 38 of 39 columns are **bit-for-bit identical** when sorted.
- Only `yelp_review_count` is perturbed: paired |Δ| mean 16.3, σ 22.2, max 106.
- A row-hash join on the 37 stable columns matches all 728 rows.

Per the professor: the student version's noise applies only to
`yelp_review_count`. Worth telling students explicitly so the "I have a
different dataset" framing doesn't lead them to assume their model is uniquely
theirs — it isn't, except for one feature.

Script: [scripts/02_compare_versions.py](scripts/02_compare_versions.py),
output: [output/02_compare_versions.txt](output/02_compare_versions.txt).

---

## 7. Recommendations (rewritten for v2)

The dataset is locked. The pedagogy (prior + retrain) is intentional. The
levers we have are: (a) what the game exposes, (b) what students are told.

### P0 — game-side fix, ~30 minutes of code

**1. Add decision-input columns to the student CSV.** In
`games/bakery-bash/app/src/components/game/RoundHeader.tsx`, extend
`CSV_COLUMNS` and `serializeRow()` to include the 8 backend-already-computed
fields:

```
num_products,
croissant_qty_stocked, cookie_qty_stocked, bagel_qty_stocked,
sandwich_qty_stocked, coffee_qty_stocked, matcha_qty_stocked,
price_croissant, price_cookie, price_bagel,
price_sandwich, price_coffee, price_matcha
```

These are already in the backend CSV (`csv-export.js` lines 60–75) and on the
player's round doc per `BACKEND.md`. Surfacing them turns the student CSV from
"a record of what happened to me" into "a re-trainable y ~ X dataset." Without
this, §4's S3 strategy isn't actually executable in the game.

**2. (Optional) Surface per-product satisfaction.** Currently excluded from the
student export by design. If the goal is full re-training capability, add the
6 `*_satisfaction_pct` columns. If the goal is to force students to think
holistically about satisfaction, leave them out — but then call this out
explicitly in the assignment so students know the limitation.

### P1 — pedagogical scaffolding, instructor-side

**3. Teach the noise-feature problem explicitly.** §3 shows that naive OLS on
the FULL dataset gives sign-flipped coefficients on the most important game
decisions. This is *the* teaching moment but only if students know to look for
it. Suggested pre-game lab exercise: have students compare FULL vs LEAN
coefficients (script `05_noise_features_bias.py` here is a ready template) and
discover the bias themselves. Then they walk into the game knowing to drop
location/traffic/size and the dataset-only products and channels.

**4. Provide a 220-tier Excel scaffold.** Re-training in Excel during a
5-minute decision window is hard. A pre-built workbook with:
- a "paste round results here" tab,
- a regression formula sheet that re-fits coefficients automatically,
- a "predicted revenue under X scenario" tab with the team's decisions,

would let MGSC 220 students execute the intended online-update loop without
hand-rolling LINEST. Otherwise the experience is asymmetric — 310 students
re-train, 220 students play by intuition.

**5. Clarify the per-student noise scope.** Currently only `yelp_review_count`
is noised, so students who compare datasets will find them ~identical. Either:
(a) tell students up front that the dataset is shared except for `yelp` and
the assignment is graded on modeling craft; or (b) actually broaden the
per-student noise generator.

### P2 — game-side, larger changes

**6. Increase observation budget if pedagogy depends on it.** §4 shows online
updates only meaningfully bite at ~150 observations. If "demonstrate the value
of online learning" is a stated learning objective, consider:
- More rounds (8–10 instead of 5), or
- Multiple game sessions where students keep their model across runs, or
- Pooling observations across teams (allow students to share their CSVs
  *post-game* and re-train on the combined set).

**7. Decide what to do with the cleanliness/maintenance signal.** Game has a
burglary mechanic tied to `cleanliness_pct` and the `*_health_pct` maintenance
bars. Dataset has `cleanliness_grade` (0.56% importance) and
`maintenance_staff_count` (0.46%) but the curveball isn't visible in the
dataset's `total_units_sold` distribution. Students who model from the dataset
won't anticipate burglary's revenue impact. Either expose this in the game's
training material, or downweight the maintenance mechanic if the dataset
doesn't reflect it.

### P3 — hygiene

**8. Move the watermark out of the CSV.** The 40th column titled
`this material is designated for educator use only and should not be distributed`
trips students up. Rename file or use a sidecar README.

**9. Document the chef vocabulary mapping.** Game uses `French / Japanese /
Italian / American` and `Novel / Intermediate / Advanced`; dataset uses
`classical_french / east_asian / mediterranean / american_comfort` and
`novice / intermediate / expert / master`. Either align labels or publish a
mapping table for students.

---

## 8. Open questions for the professor

1. **Should `*_qty_stocked` and `price_*` be added to the student CSV** (P0
   above)? This is the biggest lever and the lowest cost. Without it the
   "online update" pedagogy is mostly aspirational.
2. **Is the asymmetry between 220 and 310 acceptable?** Without an Excel
   scaffold, 220 students will struggle to re-train; 310 students with sklearn
   will breeze through. Acceptable variance, or worth investing in scaffolding?
3. **Is the per-student noise generator behaving as intended?** Currently only
   `yelp_review_count` is perturbed. If the intent was just to nudge `yelp` and
   nothing else, fine — but worth confirming.
4. **Will rounds beyond 5 ever ship?** §4 shows the online-update lesson only
   meaningfully fires at ~150+ obs. 5 rounds × 12 teams = 60 obs. Long-term
   thinking only.
5. **Should burglary / maintenance be in the dataset?** Currently it's a game
   mechanic with no dataset analog students can train on.

---

## 9. Limitations of this analysis

- **The retraining sim uses the dataset's DGP as a proxy for the game's DGP.**
  In reality the game has its own coefficients (per `config.js`). The sim's
  RMSE numbers should be read directionally, not literally.
- **No multi-round game telemetry analyzed.** I audited the *export shape* but
  didn't run a real game and capture the produced CSVs. Worth doing once the
  P0 fix lands.
- **No POST-01 dynamic pricing simulation.** The dataset has static survey
  prices; the game (post-POST-01) has round-by-round price submissions. The
  retraining sim treats prices as static.
- **Competitive interaction not modeled.** Game has shared demand pool +
  satisfaction-weighted allocation across teams. Dataset has one row per bakery
  with no opponent context.

---

## 10. File index

| Path | What |
|---|---|
| [analysis/FINDINGS.md](FINDINGS.md) | This report |
| [analysis/data/](data/) | Local copies of professor + student CSVs and data key |
| [analysis/scripts/01_profile.py](scripts/01_profile.py) | Dataset profile |
| [analysis/scripts/02_compare_versions.py](scripts/02_compare_versions.py) | Professor vs student CSV diff |
| [analysis/scripts/03_signal_strength.py](scripts/03_signal_strength.py) | Linear / RF / GBM benchmarks |
| [analysis/scripts/04_controllable_signal.py](scripts/04_controllable_signal.py) | Controllable vs fixed signal split |
| [analysis/scripts/05_noise_features_bias.py](scripts/05_noise_features_bias.py) | FULL vs LEAN coefficient bias |
| [analysis/scripts/06_retraining_feasibility.py](scripts/06_retraining_feasibility.py) | Re-training simulation |
| [analysis/output/](output/) | All reproducible outputs |
