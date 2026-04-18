# Game Design Proposal — Bakery Bash

**Date:** April 1, 2026 · Updated April 8, 2026 (all-hands decisions) · Updated April 15, 2026 (Chef System, Loan Shark mechanic) · Updated April 17, 2026 (Maintenance System, Station Architecture, Chef Satisfaction overhaul)
**Team:** Game Design (Dylan M. + Mia) · Frontend (AB + Kavin) · Backend (Daniel + Scott + Dylan B.)
**Target Launch:** April 27 or May 1, 2026
**Course:** MGSC 310 · Prof. Frenzel · Chapman University

> This document proposes an MVP-scoped version of Bakery Bash. It is intentionally simplified from the full design deck to maximize the chance of shipping a working game by launch day. Features can be layered on after the core loop works.

---

## Concept

Players run competing grab-and-go cafés in a shared plaza food court. Each round, they decide how much stock to carry per product, how many sous chefs to hire, and how much to bid in auctions for scarce resources (advertisements, highly-rated chefs, etc.). Product prices and starting budget are pre-set — players do not control these. A regression model running on the individual player's computer can be used to help them win. The player with the highest cumulative net revenue across all rounds wins.

> **Loan Shark Rule:** If a player's total spending in a round exceeds their available budget, the overage is treated as a loan from the loan shark. At the end of that round, the borrowed amount **plus 10% interest** on the borrowed amount is deducted from the player's revenue. Example: borrow $200 → revenue penalty = $200 (principal) + $20 (interest) = **$220 deducted**. Players are never blocked from overspending — but the cost is punishing and compounds risk.

Players receive "company emails" between rounds containing sales proceeds, market updates, and news. They export their data as CSV, build predictive models externally (Excel for MGSC 220, Python for MGSC 310), and input decisions back through the UI. There is no in-game model building. The game teaches regression modeling, price elasticity, resource optimization, and competitive strategy through direct experience.

> **Design principle:** Players do NOT see their remaining budget during active gameplay. They receive revenue reports and sales data each round but must track their own finances externally (Excel, paper, etc.). This is intentional — financial self-management is part of the challenge. **Exception:** Budget Remaining is revealed to all players on the Conclusion Screen at the end of Round 5.

---

## Target Variable

**Revenue** (continuous, in dollars). This is the output of the regression model and the metric students will try to predict. It is computed server-side — players never see the target model coefficients directly.

Revenue must be continuous (not bucketed or categorical) so students can run linear regression on it. Integer is also acceptable — you could round to whole dollars.

---

## Round Structure

5 rounds, approximately 42.5 minutes total including setup and explanation time.

| Phase | Duration | What Happens |
|---|---|---|
| 1. Decide | ~5 min | Players set quantity per product, adjust sous chef count and assignments, and add new menu items. Timer counts down. Pricing is fixed — no price inputs. |
| 2. Bidding | ~2 min | Ad auction (1 min) + Chef auction (1 min). |
| 2.5. Roster Management | ~1 min | Players organize their chef roster post-auction. Mandatory if a player won a 4th specialty chef — must lay one off before advancing. Sous chef hiring also available here. |
| 3. Simulate | ~30 sec | Backend computes throughput, satisfaction, foot traffic, and revenue. Minigame plays during processing. |
| 4. Review | ~1 min | Players see results: net revenue, amount borrowed (if any), interest charged (if any), satisfaction %, customer count, sell-out flags, leaderboard update. |
| 4.5. Company Email | — | Market insight email delivered — hints at next round's trending products. Data exportable as CSV. |
| 5. Repeat | — | Next round begins. New data row appended to player's dataset. |
| 6. Conclusion | ~2 min | After Round 5 only: Conclusion Screen displays final rankings, net revenue, loan shark charges, budget remaining, and winner banner with full chef roster. Read-only. |

> **Total with roster management and conclusion: ~9.5 min/round × 5 rounds + setup + conclusion = ~54 min.** Schedule should account for the added roster step and end-game screen.

---

## Player Decisions (MVP)

Three base decision inputs per round.

| Decision | Input Type | What Player Does | Why It Matters |
|---|---|---|---|
| Quantity | Stock quantity per product | Set quantity for each product | Players must balance supply cost against expected demand — over-buy wastes budget, under-buy causes sell-outs |
| Sous Chef Hiring | Integer | Choose how many sous chefs to hire and assign each to a product | Marginal returns — more sous chefs = more throughput, but costs escalate and excess sous chefs reduce Chef Satisfaction Score |
| Ad/Chef Bids | $ amount | Choose how much to spend on bidding | Competitive — shared customer pool means ad and chef ROI depends on others' spend |

> **Pricing is fixed per product for MVP.** Players do not set prices. This simplifies the decision space and keeps the regression model focused on throughput, staffing, and bidding variables. Per-product dynamic pricing is a post-MVP feature.

**Fixed product prices (MVP):**

| Product | Fixed Price |
|---|---|
| Coffee | $4.00 |
| Croissant | $4.75 |
| Bagel | $3.00 |
| Cookie | $2.50 |
| Sandwich | $8.75 |
| Matcha | $6.25 |

### Bidding Process

Players have 1 minute to bid each round, sealed auction, highest bidder wins. Players strategize to maximize their expected value.

**Advertisements:** Players bid across 4 different advertisements (TV, radio, newspaper, billboard), each with different optimal prices and varying levels of revenue yield. **Ad auction winners get visual representation in the game** — e.g., if your bakery wins the billboard bid, other players see your bakery's ad on screen next round.

**Chefs:** Players bid across chefs with different nationalities and skill levels. Each chef has a visible nationality and skill tier, but **hidden specialty products**. Their multiplier only affects their own individual output — no stacking across chefs. See [Chef System](#chef-system) below for full details.

### Menu Items

**Base:** Croissant, Cookie, Bagel

**Option to add new menu item + quantity of stock each round.**

**New item selection:** Sandwich, Coffee, Matcha — six products, six price inputs total.

---

## Chef System

*Updated April 15, 2026*

### Overview

Chefs are biddable assets with a visible nationality and skill level, but **hidden specialty products**. Each chef's skill and specialty multipliers compound within that chef's own output only — there is no cross-chef compounding. Each chef contributes their own daily output independently, and all contributions are summed. Players must infer specialty alignment through observation and predictive modeling.

---

### Base Chef & Specialty Chef Cap

**Base Chef (Starting State)**

All players begin with a **base chef** at **1.0x output speed across all products** — no specialties, no bonuses. This is the baseline every player starts from, making the chef bidding system purely additive upside.

```
Base Chef: 1.0x speed on all 6 products (Croissant, Matcha, Coffee, Sandwich, Cookie, Bagel)
```

**Specialty Chef Cap: Maximum 3**

Players can hold a maximum of **3 specialty chefs** at any time. Specialty chefs are acquired through the auction. If a player wins a bid that would give them a 4th specialty chef, a **Chef Roster Management screen** is triggered immediately after the auction — the player must lay off one of their existing specialty chefs before proceeding. Laid-off chefs return to the auction pool for future rounds.

**Full Chef Roster State at Any Time:**

| Slot | Chef | How Acquired |
|---|---|---|
| Always present | Base Chef (1.0× on all products, no specialty) | Automatic — cannot be removed |
| Specialty Slot 1 | Bidded specialty chef (or empty) | Won at auction |
| Specialty Slot 2 | Bidded specialty chef (or empty) | Won at auction |
| Specialty Slot 3 | Bidded specialty chef (or empty) | Won at auction |
| Sous Chef slots (unlimited) | Generic output helpers | Hired directly — no auction |

**Strategic implications of the cap:**
- Players must actively manage their chef roster — not just acquire, but also cut
- A laid-off high-skill chef re-entering the auction can shift the competitive dynamic significantly
- Players may strategically lay off chefs to disrupt opponents (e.g. releasing a chef a competitor wants back)
- Knowing opponents' roster compositions (based on who bid on what) becomes part of the predictive modeling

---

### Chef Roster Management UI

After each auction phase, players are shown a **Chef Roster screen** where they organize their kitchen team. If a player wins a bid that would push them over 3 specialty chefs, this screen is mandatory — they cannot advance until the roster is resolved.

**Screen layout:**
- **Base Chef card** — always present, greyed out, cannot be removed
- **Specialty Slots 1–3** — filled chef portrait cards, or empty slot placeholders
- **Overflow slot** — newly won chef displayed here if no open specialty slot exists, highlighted to indicate action required
- **Sous Chef panel** — always visible alongside the specialty roster:
  - Current sous chef count
  - Next hire cost
  - "+ Hire Sous Chef" button (deducts from budget immediately)
  - Sous chef output rate shown based on current highest specialty chef on team

**Lay-off flow:**
- Player selects any specialty chef card and taps "Lay Off"
- Confirmation prompt: *"Release [Chef Name] back to the auction pool?"*
- On confirm: chef is removed from roster, returned to auction pool for future rounds
- Player cannot advance to the next phase until specialty slots ≤ 3

**Chef card display (what players see on each card):**
- Chef portrait (nationality/gender/variant)
- Nationality flag
- Skill level (Novel / Intermediate / Advanced)
- Name
- Specialty products: **not shown**

---

### Sous Chefs

Sous chefs are **non-specialty helpers** that players can hire directly — no auction required. They are unlimited in number, but each additional sous chef costs progressively more, reflecting the management overhead of a larger kitchen team.

**Sous chef output:**

Each sous chef must be assigned to a specific product each round. Their output is **0.5× the head chef's daily output on that assigned product**. Head chef = the highest-skill specialty chef currently on the team. The sous chef benefits from the head chef's full output on that product — including the specialty bonus if the product is the head chef's specialty.

**Escalating hire cost:**

| Sous Chef # | Cost Multiplier (relative to base hire cost) |
|---|---|
| 1st | 1.0× (base cost) |
| 2nd | 1.5× |
| 3rd | 2.25× |
| 4th | 3.0× |
| 5th+ | +0.75× per additional chef |

> Exact base cost should be tuned to the existing budget economy. The principle: a few sous chefs are affordable throughput insurance; stacking many becomes expensive and creates diminishing returns relative to winning better specialty chefs at auction.

```
Sous Chef Output on Product X =
    0.5 × (Head Chef's Daily Output on Product X)

Head Chef Output on Product X =
    30 × Head Chef's Skill Multiplier
    (× Specialty Multiplier if Product X is the head chef's specialty)
```

**Example:** Advanced French chef is the head chef (specialty: Croissant, Coffee):

| Sous Chef Assignment | Head Chef Output | Sous Chef Output |
|---|---|---|
| Croissant (specialty) | 30 × 2.2 = 66 units/day | 66 × 0.5 = **33 units/day** |
| Bagel (non-specialty) | 30 × 1.6 = 48 units/day | 48 × 0.5 = **24 units/day** |

> Assigning a sous chef to a product the head chef specializes in yields higher sous chef output — incentivizing players to align sous chef assignments with their head chef's nationality.

---

### Chef Satisfaction Score

*Updated April 17, 2026 — now incorporates cleanliness and voluntary departure mechanic.*

Kitchen cohesion is tracked by a **Chef Satisfaction Score (0–100)** that acts as a throughput multiplier on total daily output. Two factors now drive it: **overcrowding** (too many sous chefs) and **cleanliness** (maintained by Maintenance Guys — see [Maintenance System](#maintenance-system)).

**Overcrowding penalty — Threshold: 4 sous chefs.** At or below 4, the kitchen runs efficiently. Beyond 4, each additional sous chef reduces the score.

**Cleanliness bonus.** Higher store cleanliness adds to the score, rewarding players who invest in Maintenance Guys.

```
Chef Satisfaction Score = max(35, 100 − max(0, sous_chef_count − 4) × 16)
                          + (cleanliness_pct × 0.10)   ← up to +10 bonus points at 100% clean
```

> The cleanliness bonus is capped so it cannot push the score above 100. A perfectly clean kitchen at 4 sous chefs scores 100 (no further benefit from cleanliness). But a messy kitchen with 6 sous chefs at 50% cleanliness scores 68 + 5 = 73 — cleanliness partially offsets the overcrowding penalty.

| Sous Chef Count | Score (at 100% clean) | Score (at 50% clean) | Score (at 0% clean) |
|---|---|---|---|
| 0–4 | 100 (capped) | 95 | 85 |
| 5 | 94 | 89 | 79 |
| 6 | 78 | 73 | 63 |
| 7 | 62 | 57 | 47 |
| 8+ | 45 | 40 | 35 (floor) |

**Effect on throughput (sole penalty mechanism):**

```
Effective Daily Output = Total Calculated Output × (Chef Satisfaction Score ÷ 100)
```

A kitchen at score 52 produces only 52% of theoretical maximum throughput. Chef Satisfaction Score is the only penalty — there is no separate regression coefficient for it. The throughput reduction flows naturally into lower fill rates → lower satisfaction % → lower foot traffic → lower revenue.

---

### Specialty Chef Voluntary Departure

**Specialty chefs (not sous chefs or the base chef) have individual satisfaction scores that decay over time.** If a specialty chef's personal satisfaction drops to or below **30%**, they voluntarily leave the establishment and immediately re-enter the **auction pool** for the next round. Players receive an in-game notification: *"[Chef Name] has left the kitchen."*

**Satisfaction decay rate by skill level:**

| Skill Level | Satisfaction Decay Per Round |
|---|---|
| **Novel** | −8 points/round |
| **Intermediate** | −14 points/round |
| **Advanced** | −20 points/round |

> Higher-skill chefs have higher standards. An Advanced chef who joins at 100% satisfaction will leave after ~3.5 rounds of neglect (100 → 80 → 60 → 40 → 20). An Intermediate takes ~5 rounds. A Novel chef takes ~8 rounds.

**What raises specialty chef satisfaction:**
- Cleanliness above 70%: +5 points/round per specialty chef
- Cleanliness above 90%: +10 points/round per specialty chef
- Keeping sous chef count ≤ 4: +3 points/round per specialty chef (orderly kitchen signal)
- All station machines above 70% health: +3 points/round per specialty chef (well-maintained workspace)
- The specialty chef's own station machine above 90% health: additional +5 points/round (their primary tool is in excellent condition)

**What accelerates satisfaction loss:**
- Cleanliness below 30%: additional −5 points/round per specialty chef
- Sous chef count ≥ 7: additional −5 points/round per specialty chef (chaotic kitchen)
- Any station machine below 40% health: −5 points/round per specialty chef (degraded working conditions)
- The specialty chef's own station machine below 20% health: additional −8 points/round (their primary tool is nearly broken)

> **Machine-to-chef station mapping for satisfaction:** A French chef (specialty: Croissant, Coffee) is tied to the Bakery Station (Oven) and the Barista Station (Espresso Machine). A Japanese chef (Matcha, Croissant) is tied to both the Barista Station and Bakery Station. An Italian chef (Sandwich, Coffee) is tied to the Deli and Barista Station. An American chef (Bagel, Cookie) is tied to the Deli and Bakery Station. The "own station machine" penalty/bonus uses the machine health of whichever of the chef's stations is in the worst condition.

> **Strategic implication:** A player who neglects maintenance risks losing their highest-skill specialty chefs through two compounding channels — a dirty kitchen accelerates satisfaction decay, and broken machines at the chef's station stack an additional penalty on top. An Advanced chef working at a Barista Station with a broken Espresso Machine (< 20% health) and a dirty kitchen (< 30% cleanliness) loses up to −20 (base decay) − 5 (dirty) − 8 (broken primary machine) = **−33 points per round** — departing in roughly 3 rounds from full satisfaction.

---

### Bidding

Chefs enter the bidding pool with a **higher minimum bid floor** than standard items — reflecting their strategic value.

| Skill Level | Proposed Minimum Bid |
|---|---|
| **Novel** | ~2× baseline item floor |
| **Intermediate** | ~3–4× baseline |
| **Advanced** | ~5–6× baseline |

> Exact values should be tuned to the existing bid economy. The principle: chefs should feel like meaningful investments that players compete over.

---

### What Players Can See vs. What's Hidden

| Attribute | Visible to Players? |
|---|---|
| Chef Nationality (French, Japanese, Italian, American) | ✅ Yes |
| Skill Level (Novel, Intermediate, Advanced) | ✅ Yes |
| Specialty Products | ❌ Hidden |
| Output Multiplier Values | ❌ Hidden |

This is the core tension: players know a French chef is *probably* good at Croissants and Coffee, but the game never confirms it. They must build that inference through their predictive model.

---

### Individual Chef Output Multipliers

Each chef independently produces a quantity of product per day based on a **base rate × their skill multiplier**. The total product output for any given item is the **sum of every chef's individual contribution** — including the base chef who is always present.

**Base rate:** 30 units/day (applies to every chef, including base chef)

| Skill Level | Non-Specialty Multiplier | Specialty Multiplier |
|---|---|---|
| **Novel** | 1.0× | 1.4× |
| **Intermediate** | 1.25× | 1.75× |
| **Advanced** | 1.6× | 2.2× |

**Output formula per chef:**
```
Chef Daily Output = Base Rate (30) × Skill Multiplier
```

**Total product output formula:**
```
Total Daily Output (e.g. Croissants) =
    Base Chef             (30 × 1.0)
  + Specialty Chef A      (30 × their multiplier)
  + Specialty Chef B      (30 × their multiplier)
  + Specialty Chef C      (30 × their multiplier)
```

**Concrete example — Croissant output with 2 specialty chefs:**

| Chef | Type | Multiplier | Daily Output |
|---|---|---|---|
| Base Chef | — | 1.0× | 30 units |
| Intermediate French Chef | Specialty (Croissant) | 1.75× | 52.5 units |
| Advanced Japanese Chef | Specialty (Croissant) | 2.2× | 66 units |
| **Total** | | | **148.5 units/day** |

> **Supply cap:** Total output is bounded by the quantity of supplies the player purchased that round. If a player only stocked 100 units of Croissant supplies, output is capped at 100 regardless of chef capacity.

**Non-specialty example:** An Intermediate French chef assigned to Bagels (not their specialty) outputs 30 × 1.25 = 37.5 units/day.

Players never see multiplier values — they observe resulting throughput and satisfaction signals over time and must infer chef alignment through their predictive model.

---

### Chef Nationalities & Specialties

Each nationality has two hidden specialty products. Multipliers below show output per chef per round based on skill level.

| Nationality | Specialties | Novel (Base / Specialty) | Intermediate (Base / Specialty) | Advanced (Base / Specialty) |
|---|---|---|---|---|
| **French** | Croissant, Coffee | 1.0× / 1.4× | 1.25× / 1.75× | 1.6× / 2.2× |
| **Japanese** | Matcha, Croissant | 1.0× / 1.4× | 1.25× / 1.75× | 1.6× / 2.2× |
| **Italian** | Sandwich, Coffee | 1.0× / 1.4× | 1.25× / 1.75× | 1.6× / 2.2× |
| **American** | Bagel, Cookie | 1.0× / 1.4× | 1.25× / 1.75× | 1.6× / 2.2× |

> Specialties are never shown to players. Nationality is visible — players must infer specialty alignment through observed throughput over time.
>
> **Overlap note:** French and Japanese both specialize in Croissant; French and Italian both specialize in Coffee. This is intentional — a player who holds one of each can double their Croissant or Coffee throughput, making cross-nationality stacking a high-reward strategy. The risk is that it requires two high-cost bids to execute and leaves other products underserved.

---

### Chef Spawn Rates by Round

Spawn rate = probability a chef of that skill level appears in the auction pool for a given round. Male and female chefs of the same nationality share identical spawn rates. As the game progresses, high-skill chefs become more available to sustain competitive spending pressure.

| Skill Level | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 |
|---|---|---|---|---|---|
| **Novel** | 65% | 55% | 40% | 20% | 5% |
| **Intermediate** | 30% | 35% | 40% | 45% | 45% |
| **Advanced** | 5% | 10% | 20% | 35% | 50% |

> Rates apply equally across all nationalities and both genders. Early rounds favor low-skill chefs to keep the auction economy accessible; late rounds surface high-skill chefs to reward players who have built strong cash positions.

---

### Revenue Flow

```
Each Chef:
    Base Rate (30 units/day) × Skill Multiplier = Chef's Daily Output

Sum of all chefs' daily outputs = Total Product Throughput
        ↓
    (capped by player's purchased supply quantity)
        ↓
Product Throughput → Customer Satisfaction
        ↓
Satisfaction → Foot Traffic
        ↓
Foot Traffic × Price × Conversion Rate = Revenue
```

---

### Strategic Loop

The hidden specialty system creates a **deduction game on top of the bidding game**:

1. Player sees an Advanced Japanese chef up for bid — bids aggressively expecting Matcha upside
2. Player stocks up on Matcha inventory to align with that chef
3. Over rounds, they observe higher throughput on Matcha → satisfaction rises → more traffic
4. That data point reinforces (or corrects) their predictive model for future rounds

Players who **misalign** chef purchases with inventory get penalized silently through weaker throughput — no explicit error, just worse outcomes that sharp players will notice.

---

### Chef Roster — Nationality, Specialties & Multipliers

Each chef is randomly generated using the framework below. Specialty products are **hidden from players** and must never be surfaced in the UI.

> **Asset Design Note:** Each entry includes a primary archetype and diverse variant suggestions. For culturally heterogeneous nationalities (French, American), multiple skin tone and hair type representations are listed — the generator can spawn any variant. All descriptions are direct input for front-end character design.
>
> **Scope:** Design each chef as a **head and neckline only** — portrait-style avatar icon. The crop should extend just past the collar so that neck attire (neckerchief, coat collar) is visible. No full body required.

---

#### 🇫🇷 French
**Specialties (Hidden):** Croissant, Coffee
**Possible Names — Male:** Jean-Pierre, Marcel | **Female:** Colette, Amélie

| Gender | Variant | Skin Tone | Hair | Facial Hair / Features | Accessories (randomizable) | Hat | Neckline |
|---|---|---|---|---|---|---|---|
| Male | **A — Classic Parisian** | Light/fair, slight olive undertone | Short brown hair, neatly combed back | Thin classic French handlebar mustache, waxed tips | None / simple gold signet ring visible at collar cuff | Tall toque blanche, straight and starched | Double-breasted white chef coat, blue neckerchief |
| Male | **B — Afro-French** | Deep warm brown (West/Central African-French heritage) | Short tight coils or low fade | Thin pencil mustache | Small gold stud earring / thin gold chain above neckerchief / small hoop | Toque blanche, slightly tilted | Same coat, blue neckerchief, relaxed |
| Male | **C — Maghrebi-French** | Medium tan/warm beige (North African-French heritage) | Short dark straight hair, side-parted | Clean-shaven with faint stubble | Thin silver chain above collar / small silver stud / none | Toque blanche | Classic coat, blue neckerchief |
| Female | **A — Classic Parisienne** | Fair, light pink undertone | Long brown hair in two braids draped forward | — | Pearl studs / small diamond studs / delicate gold drops | Low toque blanche, slightly tilted | Fitted white coat with blue trim at collar |
| Female | **B — Afro-French** | Deep brown (West African-French heritage) | Long box braids or thick natural twists, pulled loosely to one side | — | Gold hoops / large statement hoops / beaded drop earrings | Low toque blanche or chef's beret | Same fitted coat with blue trim |
| Female | **C — Maghrebi-French** | Warm medium tan | Dark wavy hair in two loose braids | — | Silver crescent earrings / turquoise studs / small silver hoop with charm | Low toque blanche | Fitted coat, blue trim |

**Multipliers by Skill Level:**

| Skill Level | Non-Specialty Products | Specialty Products (Croissant, Coffee) |
|---|---|---|
| **Novel** | 1.0× | 1.4× |
| **Intermediate** | 1.25× | 1.75× |
| **Advanced** | 1.6× | 2.2× |

---

#### 🇯🇵 Japanese
**Specialties (Hidden):** Matcha, Croissant
**Possible Names — Male:** Hiroshi, Kenji | **Female:** Yuki, Aiko

| Gender | Variant | Skin Tone | Hair | Facial Hair / Features | Accessories (randomizable) | Headwear | Neckline |
|---|---|---|---|---|---|---|---|
| Male | **A — Traditional** | Light/medium warm beige | Short straight black hair, neatly cut | Clean-shaven | None | White hachimaki tied at back, knot on side | Minimalist white chef coat, dark charcoal-gray apron |
| Male | **B — Modern Tokyo** | Light/medium warm beige | Slightly longer black hair, subtle textured fringe | Clean-shaven | Small silver stud (one ear) / thin black cord necklace / tiny geometric ear cuff | White hachimaki worn lower on forehead | Slim-fit white coat, black apron, rolled sleeves |
| Female | **A — Traditional** | Light/medium warm beige | Black hair with blunt straight-cut bangs, high ponytail | — | Cherry blossom hair clip / red kanzashi pin / white floral clip at ponytail base | White hachimaki tied at ponytail base | Clean white coat, black apron with subtle embroidered edge |
| Female | **B — Modern Tokyo** | Light/medium warm beige | Black hair, wispy side-swept bangs, high ponytail | — | Tiny silver studs / small pearl studs / minimalist geometric ear cuff | White hachimaki as thin headband across forehead | Slim-fit coat, dark apron, sleeves slightly rolled |

**Multipliers by Skill Level:**

| Skill Level | Non-Specialty Products | Specialty Products (Matcha, Croissant) |
|---|---|---|
| **Novel** | 1.0× | 1.4× |
| **Intermediate** | 1.25× | 1.75× |
| **Advanced** | 1.6× | 2.2× |

---

#### 🇮🇹 Italian
**Specialties (Hidden):** Sandwich, Coffee
**Possible Names — Male:** Marco, Luca | **Female:** Sofia, Giulia

> **Hat note for designers:** The cappello da cuoco is NOT the tall stiff toque blanche. It is a rounded, soft, pleated fabric hat — more like a gathered pillowcase shape sitting loosely on the head. Reference: traditional Italian trattoria chef imagery.

| Gender | Variant | Skin Tone | Hair | Facial Hair / Features | Accessories (randomizable) | Hat | Neckline |
|---|---|---|---|---|---|---|---|
| Male | **A — Classic Southern Italian** | Warm olive/medium tan | Short dark brown curly hair | Full thick Italian mustache, slightly curled ends | Thin gold chain above neckerchief / small gold cornicello pendant / none | Cappello da cuoco (floppy, pleated, worn slightly slouched) | White double-breasted coat, red neckerchief tied loosely |
| Male | **B — Northern Italian** | Fair/light olive | Short straight dark hair, neat | Thinner groomed mustache with slight stubble | Simple silver chain above collar / small silver medallion / none | Cappello da cuoco, more upright | Same coat, red neckerchief |
| Female | **A — Classic Southern Italian** | Warm olive/medium tan | Dark wavy hair pulled up under hat, loose strands framing face | — | Small gold hoops / coral drop earrings / gold knot studs | Cappello da cuoco (floppy, pleated, worn softly) | White coat with red trim at collar, red neckerchief |
| Female | **B — Northern Italian** | Fair with warm undertone | Dark straight hair in low bun under hat | — | Simple silver studs / small pearl drops / thin silver hoops | Cappello da cuoco, slightly neater fit | Same coat and neckerchief, polished stance |

**Multipliers by Skill Level:**

| Skill Level | Non-Specialty Products | Specialty Products (Sandwich, Coffee) |
|---|---|---|
| **Novel** | 1.0× | 1.4× |
| **Intermediate** | 1.25× | 1.75× |
| **Advanced** | 1.6× | 2.2× |

---

#### 🇺🇸 American
**Specialties (Hidden):** Bagel, Cookie
**Possible Names — Male:** Jake, Tyler | **Female:** Madison, Ashley

| Gender | Variant | Skin Tone | Hair | Facial Hair / Features | Accessories (randomizable) | Hat | Neckline |
|---|---|---|---|---|---|---|---|
| Male | **A — Classic All-American** | Fair/light, slight freckles | Short brown hair | Goatee, neat and trimmed close | None / small stud earring (one ear) / simple dog tag chain at neckline | Backwards baseball cap (white or khaki, no logo) | White chef coat worn open over plain white/grey t-shirt |
| Male | **B — African American** | Medium-deep brown | Short natural hair or low fade | Goatee or full short beard | Small gold hoop (one or both ears) / gold chain at neckline / diamond stud | Backwards baseball cap (dark color) | Same casual coat, denim apron visible at neckline |
| Male | **C — Latino-American** | Warm medium tan | Short dark hair, slightly wavy | Goatee | Small gold stud / thin gold chain at collar / none | Backwards cap | Same outfit, broad relaxed build |
| Female | **A — Classic** | Fair/light | Brown or blonde hair in neat bun, a few face-framing pieces loose | — | Small studs / tiny turquoise drops / minimalist bar earrings | No hat — bun is the signature | White coat with rolled sleeves, casual denim apron |
| Female | **B — African American** | Medium-deep brown | Natural hair in high puff bun or twisted updo | — | Gold hoops / large beaded hoops / cowrie shell drops | No hat | Same rolled-sleeve coat, denim apron |
| Female | **C — Latina** | Warm medium tan | Dark hair in sleek bun | — | Small gold huggies / turquoise studs / red enamel drops | No hat | Same outfit, athletic build |

**Multipliers by Skill Level:**

| Skill Level | Non-Specialty Products | Specialty Products (Bagel, Cookie) |
|---|---|---|
| **Novel** | 1.0× | 1.4× |
| **Intermediate** | 1.25× | 1.75× |
| **Advanced** | 1.6× | 2.2× |

---

### Open Questions Resolved ✅

| Question | Answer |
|---|---|
| Chef cost/bidding? | Bid-based, higher minimum floor by skill tier |
| Specialty visibility? | Hidden — nationality + skill level shown only |
| Leveling up? | No — purchased at fixed skill level |
| How do multiple chefs interact? | Additive — each chef independently contributes their own daily output; total = sum of all chefs. Multipliers are not compounded on top of each other. |

---

---

## Station Architecture

*Added April 17, 2026*

The bakery is divided into **3 operational stations**. Each station produces a specific set of products, contains one machine, and represents the physical zone where sous chefs work and where the Maintenance Guy may need to service equipment.

| Station | Products Produced | Machine |
|---|---|---|
| **Bakery Station** | Croissant, Cookie | Oven |
| **Deli** | Bagel, Sandwich | Meat Slicer |
| **Barista Station** | Matcha, Coffee | Espresso Machine |

**Sous chefs are assigned per station, not per product.** When a player hires a sous chef for the Barista Station, that sous chef contributes output to both Matcha and Coffee proportionally based on round demand. Station assignment is set during the Decide phase via the Staff Tab (see [Staff Tab UI](#staff-tab-ui)).

**Machine health is tracked per station** as a maintenance percentage bar (0–100%). Each time an item from a station is ordered, that station's machine health drops. If a machine's health falls to 0%, it is considered broken — production from that station is halved until a Maintenance Guy repairs it. See [Maintenance System](#maintenance-system).

---

## Maintenance System

*Added April 17, 2026*

### Overview

The **Maintenance Guy** is a new staff role players hire directly (no auction). They perform two types of tasks: **janitorial work** (restoring store cleanliness) and **machine repair** (restoring a station's machine health). Each Maintenance Guy can only work on **one task at a time** — clean the store OR service one specific machine. To address multiple degrading bars simultaneously, players must hire more Maintenance Guys.

Maintenance Guys are assigned at the start of each round during the Decide phase and remain on their assigned task for the full duration of that round's operating hours.

---

### Dirtiness Mechanic

**Cleanliness** is a store-wide percentage bar (0–100%) that starts each game at 100% and degrades as customers pass through.

```
Cleanliness drops 3% for every customer who enters the store
(regardless of whether they make a purchase)
```

> At 100 customers/round, cleanliness drops by 3 points per customer = −300% equivalent over a busy round, but it floors at 0%. The practical pace: a mid-traffic round (50 customers) drops cleanliness by ~150 raw points — but since the bar floors at 0%, a store that opens the round at 20% cleanliness will hit 0% early and remain there. Players must proactively assign Maintenance Guys to stay above dangerous thresholds.

**Cleanliness thresholds and effects:**

| Cleanliness % | State | Effect on Chef Satisfaction |
|---|---|---|
| 91–100% | Spotless | +10 to Chef Satisfaction Score |
| 71–90% | Clean | +5 to Chef Satisfaction Score |
| 31–70% | Acceptable | No modifier |
| 11–30% | Dirty | −5 to specialty chef personal satisfaction/round |
| 0–10% | Filthy | −10 to specialty chef personal satisfaction/round; additional −5 to throughput score |

---

### Machine Maintenance Mechanic

Each station has its own **Machine Health bar** (0–100%), starting at 100% at the beginning of the game.

```
Machine Health drops 2% for every item ordered from that station
```

| Station | Machine | Drops when... |
|---|---|---|
| Bakery Station | Oven | A Croissant or Cookie is ordered |
| Deli | Meat Slicer | A Bagel or Sandwich is ordered |
| Barista Station | Espresso Machine | A Coffee or Matcha is ordered |

**Machine Health thresholds and effects:**

| Machine Health % | State | Effect on Station Output |
|---|---|---|
| 71–100% | Optimal | Full throughput |
| 41–70% | Worn | −15% throughput for that station's products |
| 11–40% | Degraded | −35% throughput for that station's products |
| 0–10% | Broken | −50% throughput for that station's products |

> **Example:** A Barista Station Espresso Machine at 25% health (Degraded) produces only 65% of its normal Coffee and Matcha throughput. A player with an Advanced French chef on Coffee will still suffer if they neglect the espresso machine — raw chef skill cannot compensate for a broken machine.

---

### Maintenance Guy Mechanics

**What a Maintenance Guy does:**

Each Maintenance Guy is assigned to exactly one of the following tasks at the start of a round:
- **Clean Store** → increases Cleanliness bar
- **Repair Oven** → increases Bakery Station machine health
- **Repair Meat Slicer** → increases Deli machine health
- **Repair Espresso Machine** → increases Barista Station machine health

**Restoration rate:**

```
Each Maintenance Guy restores the assigned bar by +15% per operational hour
```

> Operational hours per round = number of hours the café is open during that round (exact value set by backend config; default: 8 hours/round). A single Maintenance Guy assigned to cleaning all round restores +120% cumulative — enough to recover from a high-traffic round if started from acceptable levels. A round where cleanliness opens at 20% needs a Maintenance Guy assigned to cleaning for the full round just to end above 50%.

**Hiring cost:**

| Maintenance Guy # | Cost per Round |
|---|---|
| 1st | Base cost (TBD — tune to budget economy) |
| 2nd | 1.5× base cost |
| 3rd | 2.25× base cost |
| 4th+ | +0.75× per additional |

> Cost escalation mirrors the sous chef hiring curve — more coverage costs more. The strategic question: do you pay for a 3rd Maintenance Guy to keep all three machines healthy, or do you invest that budget in a specialty chef instead?

**One task at a time — no multi-tasking:**

A single Maintenance Guy cannot split their time between cleaning and repair in the same round. If a player has 1 Maintenance Guy and assigns them to clean, all three machine health bars degrade unaddressed that round. Managing multiple degrading bars is the core resource-allocation puzzle of the Maintenance system.

**Capacity planning example:**

| Scenario | Maintenance Guys Needed |
|---|---|
| Keep cleanliness healthy only | 1 |
| Keep cleanliness + 1 machine healthy | 2 |
| Keep cleanliness + all 3 machines healthy | 4 (1 per task) |
| Catch up a heavily degraded state (multiple bars near 0%) | 4+ |

---

### Maintenance State Persistence

All four bars (cleanliness, oven, meat slicer, espresso machine) **persist between rounds** — they do not reset. A player who neglects maintenance for two rounds will enter round 3 with compounded degradation. The only way to recover is to assign Maintenance Guys.

Bar values are stored on the player's Firestore document and updated by the backend simulation engine at the end of each round.

---

### Maintenance & CSV Export

Two new columns are added to the player's CSV export to support regression modeling:

| Column | Type | Description |
|---|---|---|
| `avg_cleanliness_pct` | float | Average cleanliness % across the round (0–100) |
| `avg_machine_health_pct` | float | Average across all three machine health bars (0–100) |
| `maintenance_guy_count` | int | Number of Maintenance Guys hired this round |

---

## Customer Satisfaction & Foot Traffic System

### How the System Works

**Customer Satisfaction Rate** and **Foot Traffic** are the two core output metrics. They are driven by the following factors:

```
Customer Satisfaction Rate (displayed as % to players, included in CSV) is determined by:
    1. Speed of production — higher chef throughput/multipliers → more units produced
       → higher fill rate → higher satisfaction
    2. Product availability — if a product sells out mid-round, satisfaction drops
       and product-loyal customers leave for a competitor

Foot Traffic is determined by:
    1. Customer satisfaction rate — higher satisfaction attracts more customers
    2. Product availability — sold-out products trigger immediate customer defection
    3. Speed of production — indirectly, through its effect on satisfaction
```

> **Satisfaction % is visible to players on the results screen and exported in the CSV.** It is the primary signal players use to evaluate their chef and supply decisions. A player who sees their Coffee satisfaction at 43% knows immediately they need a stronger chef or more supply — without the game ever explaining why.

The strategic loop forces players to align three things: **chef specialty → supply quantity → price point**. Misalignment in any one dimension silently penalizes revenue.

---

### Base Expected Daily Demand (Per Player)

| Product | Base Demand | Notes |
|---|---|---|
| **Coffee** | 70 units | High-volume daily staple — hardest to satisfy with base chef alone |
| **Croissant** | 60 units | Medium-volume, quality-sensitive |
| **Bagel** | 55 units | Medium-volume, price-sensitive |
| **Cookie** | 50 units | Impulse purchase |
| **Sandwich** | 45 units | Lower volume, highest margin ceiling |
| **Matcha** | 25 units | Niche/premium — few customers want it, but they pay significantly more |

**Base chef alone (30 units/day) fill rates:**

| Product | Fill Rate | Satisfaction | Strategic Signal |
|---|---|---|---|
| Coffee | 43% | Critical | Forces chef investment |
| Croissant | 50% | Poor | Forces chef investment |
| Bagel | 55% | Poor | Forces chef investment |
| Cookie | 60% | Poor | Forces chef investment |
| Sandwich | 67% | Adequate | Accessible without chef, but capped |
| Matcha | 120% | Excellent | Base chef meets demand — but a Japanese chef unlocks premium pricing |

> **The Matcha trap:** Players who skip a Japanese chef think they're fine because satisfaction reads Excellent at base. But a Japanese chef on Matcha with premium pricing is the highest revenue-per-unit play in the game — the gap between "fine" and "winning" on Matcha is invisible until a sharp player discovers it.

---

### Throughput → Satisfaction Tiers

Satisfaction is driven by **fill rate** = actual throughput (capped by supply purchased) ÷ base expected demand. The result is expressed as a **satisfaction percentage (0–100%)** shown to players on the results screen and in the CSV export. Each product has its own satisfaction %; the aggregate satisfaction % shown on the UI is the weighted average across all products offered.

**Per-product satisfaction:**

| Fill Rate | Satisfaction Tier | Satisfaction % |
|---|---|---|
| < 50% | Critical | 0–20% |
| 50–69% | Poor | 21–45% |
| 70–84% | Adequate | 46–65% |
| 85–99% | Good | 66–85% |
| 100%+ | Excellent | 86–100% |

**Sell-out mid-round:** If a product sells out before the round ends, its satisfaction % drops to the Poor tier (≤45%) for the remainder of the round — regardless of how much had already been served.

> **Supply cap:** A player with an Advanced Italian chef capable of 66 Coffee units/day who only bought 40 units of supply hits 40/70 = 57% → Poor. The chef investment is wasted. Players must purchase supply quantity that matches their chef's throughput potential.

**Recommended supply targets by chef tier:**

| Chef Tier | Daily Throughput (specialty product) | Recommended Supply |
|---|---|---|
| Base only | 30 | 30 (accept Poor/Critical on most products) |
| Base + Novel specialty | 72 | 70–75 |
| Base + Intermediate specialty | 82.5 | 80–85 |
| Base + Advanced specialty | 96 | 90–100 |
| Base + Advanced + Intermediate (same product) | 148.5 | ~100 (demand cap — surplus is waste) |

---

### Satisfaction → Foot Traffic

Foot traffic is driven by **aggregate satisfaction** — a weighted average across all products offered. Products not offered are excluded from the calculation.

**Product weights:**

| Product | Satisfaction Weight | Reason |
|---|---|---|
| Coffee | 1.5 | Expected at every café — low satisfaction here hurts overall perception most |
| Matcha | 1.3 | Premium differentiator — Excellent Matcha signals "destination café" |
| Croissant | 1.2 | Quality signal — customers notice when it's done well |
| Sandwich | 1.0 | Standard |
| Cookie | 1.0 | Standard |
| Bagel | 1.0 | Standard |

**Foot traffic modifier by aggregate satisfaction:**

| Avg Satisfaction Score | Tier | Foot Traffic Modifier |
|---|---|---|
| 0–20 | Critical | −40% |
| 21–45 | Poor | −20% |
| 46–65 | Adequate | ±0% (baseline) |
| 66–80 | Good | +20% |
| 81–100 | Excellent | +40% |

**Premium product bonus:** If Croissant or Matcha individually reaches Excellent, add +10% foot traffic each (stackable). Maximum possible modifier = **+60%**.

---

### Price Points Per Product

Three pricing zones per product. Pricing above your satisfaction tier's ceiling costs foot traffic.

| Product | Floor | Competitive Range | Premium Range | Ceiling | Elasticity |
|---|---|---|---|---|---|
| **Coffee** | $2.00 | $3.00–$4.50 | $5.00–$6.00 | $6.50 | High |
| **Croissant** | $2.50 | $4.00–$5.50 | $6.00–$7.00 | $8.00 | Medium |
| **Bagel** | $1.50 | $2.50–$3.50 | $4.00–$5.00 | $5.50 | High |
| **Cookie** | $1.00 | $2.00–$3.00 | $3.50–$4.50 | $5.00 | High |
| **Sandwich** | $5.00 | $7.50–$10.00 | $10.50–$12.50 | $14.00 | Medium |
| **Matcha** | $3.50 | $5.50–$7.00 | $7.50–$9.00 | $10.00 | Low |

> **MVP note:** Pricing is fixed for v1. The price table above defines fixed sell prices and is referenced by the revenue formula as `product_revenue_rate`. The pricing zones and elasticity rules below are **post-MVP** — they apply once dynamic per-product pricing is enabled.

**Post-MVP pricing rules (for reference):**
- Pricing above the ceiling for any product reduces that product's satisfaction % slightly each round it remains above ceiling
- Floor pricing boosts demand by 15% regardless of satisfaction tier (the volume play)

---

### Strategic Archetypes

| Strategy | Chef Investment | Supply Focus | Pricing | Risk |
|---|---|---|---|---|
| **Volume play** | Novel across multiple products | Moderate, spread across all products | Floor–Competitive | Low margin; traffic-dependent |
| **Coffee monopoly** | Advanced Italian or French | Max Coffee supply | Premium Coffee | Misses premium product foot traffic bonuses |
| **Matcha specialist** | Advanced Japanese | Max Matcha supply | Premium Matcha | Low volume; vulnerable if competitors dominate Coffee satisfaction |
| **Croissant double-down** | French + Japanese (both specialize Croissant) | Heavy Croissant supply | Premium Croissant | Expensive — two high bids required; leaves other products underfunded |
| **Balanced coverage** | 1 Intermediate + 1 Novel across different specialties | Even spread | Competitive across board | No ceiling, but consistent — hard to beat a focused specialist at their peak |

---

## Customer Behavior & Demand Variation System

---

### Round Preference Profiles

Each round, the total demand for each product shifts based on a hidden **preference profile**. The profile is randomly generated per game session but is identical for all players — everyone faces the same market, but only players who read the signals correctly will align their supply and chefs.

**Demand shift tiers:**

| Tier | Demand Modifier | Effect |
|---|---|---|
| **Trending** | +40% | More customers seeking this product enter the pool |
| **Warm** | +15% | Slight increase in customer volume for this product |
| **Neutral** | ±0% | Baseline |
| **Cold** | −25% | Fewer customers seeking this product; supply purchased for it risks being wasted |

Each round: **2 products Trending, 2 Warm, 1 Neutral, 1 Cold.** No product stays Trending two consecutive rounds — forcing strategic rotation.

**Example 5-round demand profile (randomized at game start, same for all players):**

| Round | Trending (+40%) | Warm (+15%) | Neutral | Cold (−25%) |
|---|---|---|---|---|
| 1 | Coffee, Bagel | Croissant, Cookie | Sandwich | Matcha |
| 2 | Croissant, Matcha | Coffee, Sandwich | Cookie | Bagel |
| 3 | Sandwich, Cookie | Bagel, Matcha | Coffee | Croissant |
| 4 | Matcha, Coffee | Croissant, Cookie | Bagel | Sandwich |
| 5 | Croissant, Cookie | Matcha, Bagel | Coffee | Sandwich |

**Signal reveal:** At the start of each round, players receive a **market insight email** with a vague hint (e.g., *"Food critics have been spotlighting artisan breakfast staples this week"* → hints at Croissant/Bagel trending). Exact modifiers are never shown — players must infer from the hint and prior round outcomes.

---

### Base Traffic Pool

Each round, a fixed pool of customers enters the game. The pool size is set by the base expected demand across all products, adjusted by the round preference multipliers.

```
Total Customer Pool (per round) =
    Sum of (Base Demand × Round Modifier) for each product offered across all players

Each Player's Base Traffic Share =
    Total Customer Pool × (Player's Weighted Aggregate Satisfaction Score /
                           Sum of All Players' Weighted Aggregate Satisfaction Scores)
```

**Weighted aggregate satisfaction** uses the product weights defined in the Satisfaction → Foot Traffic section (Coffee 1.5×, Matcha 1.3×, Croissant 1.2×, others 1.0×). Players not offering a product are excluded from that product's demand pool.

The base traffic share is then scaled by the **Foot Traffic Modifier** (satisfaction tier, product variety, sous chef bonus, ad bonus, availability penalties) to produce each player's actual customer count for the round.

---

### Competitive Foot Traffic Allocation (All Products)

Within each product's demand pool, each player's share of customers seeking that product is proportional to their **relative satisfaction score** for that product. This applies equally to all 6 products. The per-product demand pool is capped by the base expected demand × round modifier — the competitive allocation determines how that capped pool is divided.

```
Player's share of product X customers =
    Player's Satisfaction Score (product X)
    ──────────────────────────────────────────────────────
    Sum of all players' Satisfaction Scores (product X)

Product X demand pool = Base Demand (product X) × Round Preference Modifier
```

Players not offering a product receive zero share and are excluded from the denominator.

**Competitive splitting examples across all products:**

| Product | Player A | Player B | Player C | A's Share |
|---|---|---|---|---|
| Coffee | Excellent (95) | Good (75) | Poor (30) | 95/200 = **48%** |
| Croissant | Excellent (95) | Excellent (95) | Not offered | 95/190 = **50%** |
| Matcha | Excellent (95) | Not offered | Not offered | 95/95 = **100%** |
| Bagel | Good (75) | Good (75) | Good (75) | 75/225 = **33%** |
| Sandwich | Poor (30) | Excellent (95) | Not offered | 30/125 = **24%** |
| Cookie | Adequate (55) | Good (75) | Poor (30) | 55/160 = **34%** |

> **Key insight:** Offering a product no one else offers captures 100% of that product's customers. Entering a saturated product (e.g., three players all offering Good Bagels) means a 33% share cap regardless of effort. Dominant satisfaction scores shift share significantly — a 20-point lead in a two-player product contest yields ~55/45 split.

---

### Customer Profile Behavior (Product-Loyal vs. Brand-Loyal)

Every customer is either **product-loyal** or **brand-loyal**. This is a backend behavior rule — it is not a tracked data variable, but it drives how the customer count resolves each round.

| Scenario | Product-Loyal Customer | Brand-Loyal Customer |
|---|---|---|
| Product available, Good/Excellent satisfaction | Buys ✓ | Buys ✓ |
| Product available, Poor/Critical satisfaction | 60% defect to a competitor offering that product | Buys anyway (habit) |
| Product sold out | Defects to a competitor (see Sell-Out rules) | Orders next available product on the menu instead |
| Nothing available at all | Leaves — lost customer | Leaves — lost customer |

**Brand loyalty as a returning customer mechanic:**

Brand loyalty is earned by consistently delivering high satisfaction. It manifests as a **returning customer bonus** — a small guaranteed pool of customers in subsequent rounds who bypass competitive allocation and go directly to that bakery.

| Prior Round Aggregate Satisfaction | Returning Customer Bonus (next round) |
|---|---|
| Excellent (86–100%) | +15% of prior round's customer count, guaranteed |
| Good (66–85%) | +8% of prior round's customer count, guaranteed |
| Adequate (46–65%) | No returning customer bonus |
| Poor or Critical | Returning customer pool resets to 0 |

> Returning customers are added to the player's customer count before competitive allocation runs. This means a player who builds brand loyalty gains a compounding floor on revenue — even in a cold round where their product demand drops, loyal customers still show up. Brand loyalty is visible on the results screen as "Returning Customers" but is not included in the regression CSV.

---

### Sell-Out Mechanic

When a player's supply for a product is exhausted mid-round:

```
Sell-out triggers when:
    Cumulative demand served for product X = Units of product X purchased
```

**Consequences:**
- **Product-loyal customers** arriving after sell-out → defect to a randomly selected competitor still offering that product (weighted by their satisfaction score for that product). That competitor's customer count increases.
- If **no competitor offers that product** (e.g., everyone sold out of Matcha) → customer is a **lost customer**. They leave without purchasing anywhere.
- **Brand-loyal customers** arriving after sell-out → redirect to the next available product on your menu. Revenue is lower, but they stay.
- **Satisfaction score** for that product drops to Poor (≤45%) for the remainder of the round.
- **Returning customer bonus penalty:** If the sell-out causes aggregate satisfaction to drop below Good, the returning customer bonus for the next round is reduced accordingly.
- **Sell-out flag** visible on the round results screen — a clear signal to both the player and competitors.

---

### Full Customer Flow Per Round

```
Round Start
    ↓
Demand profile generated (hidden — partial hint via market email)
Effective demand per product = Base Demand × Round Preference Modifier
    ↓
Returning customers from prior round added to each player's count first
(bypasses competitive allocation — earned from prior round satisfaction)
    ↓
Remaining customer pool allocated to each player
(proportional to weighted aggregate satisfaction score)
    ↓
Per-product customer share split by relative satisfaction scores
    ↓
At each bakery, customers resolve:
    ├── Product-Loyal
    │       ├── Product available + Good/Excellent → Buys ✓
    │       ├── Product Poor/Critical → 60% defect to random weighted competitor
    │       └── Product sold out → Defects to random weighted competitor (or lost if none)
    │
    └── Brand-Loyal
            ├── Product available → Buys ✓
            ├── Product Poor/Critical → Buys anyway
            └── Product sold out → Orders next available product; lost if nothing available
    ↓
Sell-out events trigger mid-round defection flows
    ↓
Revenue (gross) = Σ (qty_sold_product × fixed_price_product) for each product on menu
    (Only products offered and actually purchased by customers contribute.
     Products not offered, not purchased, or fully sold out at sell-out point = $0 contribution.)
    ↓
If total spending this round > available budget:
    borrowed = spending − available budget
    loan_shark_deduction = borrowed × 1.10
    Net Revenue = Gross Revenue − loan_shark_deduction
Else:
    Net Revenue = Gross Revenue
Unsold supply = wasted (no carryover)
    ↓
Per-product satisfaction % calculated and stored
Aggregate satisfaction % (weighted average, using product weights) calculated and stored
Chef Satisfaction Score calculated and applied as throughput multiplier
All metrics written to CSV export and displayed on results screen
Returning customer bonus for next round calculated from this round's aggregate satisfaction %
    ↓
Next round
```

---

## Scoring System

**Primary metric:** Cumulative net revenue across all rounds. One number, one leaderboard. Clear winner.

**Tiebreaker:** Remaining budget at end of game. If two players have identical net revenue, the player with more budget left over wins. Budget remaining can be negative (if the player took on loan shark debt that exceeded their revenue). Excess budget is displayed on the conclusion screen but is **not added to net revenue** — it is purely a tiebreaker signal.

> Customer satisfaction % is no longer the tiebreaker. It remains visible as a performance signal but does not affect final ranking.

**CSV export includes per round:**
- Revenue (this round + cumulative)
- Customer count (purchases made)
- Per-product satisfaction % (one column per product)
- Aggregate satisfaction % (weighted average — Coffee 1.5×, Matcha 1.3×, Croissant 1.2×, others 1.0×)
- Chef satisfaction score
- Sell-out flags per product
- Returning customers (results screen only — not in regression CSV)

**Two separate UIs:**
1. **Student-facing UI** — simplified: login, decision inputs, leaderboard, company emails. No budget tracker, no model building tools.
2. **Professor / Live Ops UI** — full visibility: market share, all player data, AI bot controls, dynamic pricing levers. Scott and Dylan B. will run the control room on game day.

---

## Conclusion Screen

Displayed after Round 5 results are processed. This is the final state of the game — no further decisions can be made.

### Winner Banner

At the top of the screen, a dedicated winner announcement displays:
- **Team name** of the winning bakery (largest net revenue; tiebreaker: remaining budget)
- **Portrait avatars of the winning team's full chef roster** (base chef + all specialty chefs currently on the team), shown in a row with their names and nationalities
- A visual flourish (confetti, trophy, or similar) to mark the win moment

### Final Rankings Table

All players listed in rank order (1st → last), each row showing:

| Column | Description |
|---|---|
| Rank | 1st, 2nd, 3rd… |
| Team Name | Player/team display name |
| Total Revenue | Sum of revenue earned across all 5 rounds (before deductions) |
| Total Interest Charged | Cumulative loan shark interest paid across all rounds (0 if never over budget) |
| Net Revenue | Total Revenue − Total Interest − Total Principal Borrowed |
| Budget Remaining | Budget left at end of game (can be negative). **Tiebreaker.** Not added to Net Revenue. |

> **Budget Remaining** is calculated as: `Starting Budget + Cumulative Net Revenue − Cumulative Spending`. Net Revenue = Gross Revenue − (borrowed amount × 1.10) per round. Starting Budget is not part of Net Revenue — it is tracked separately as the financial baseline. Budget Remaining reflects whether the player ended the game with a surplus or deficit after all rounds of spending and earning. Negative values indicate the player borrowed more than they recovered.

> **Excess budget is not counted as revenue.** A player who hoarded budget does not get rewarded — the budget column only matters for breaking ties.

### Per-Player Detail (Expandable)

Players can expand their own row (or any row, for transparency) to see a round-by-round breakdown:

| Round | Revenue | Amount Borrowed | Interest Charged | Net This Round |
|---|---|---|---|---|
| 1 | $X | $0 | $0 | $X |
| 2 | $X | $Y | $Y × 10% | $X − $Y − $Y×0.10 |
| … | … | … | … | … |
| **Total** | **$X** | **$Y** | **$Z** | **Net Revenue** |

### Display Rules

- Conclusion screen is **read-only** — no decisions, no inputs.
- All players see all other players' results (full transparency at game end).
- Professor / Live Ops UI shows the same screen with an additional export button to download the full results CSV.
- Chef portraits shown in the winner banner use the same avatar assets as the in-game chef cards (head/neckline portrait style).

---

## Competitive Dynamics

### Foot Traffic Formula

There is one unified foot traffic model. All factors below feed into a single **Foot Traffic Modifier** applied to each player's base traffic allocation.

```
Foot Traffic = Base Traffic Pool Share × (1 + Foot Traffic Modifier)

Foot Traffic Modifier =
    Satisfaction Modifier       (from aggregate satisfaction %)
  + Product Variety Bonus
  + Sous Chef Bonus             (up to threshold — see Chef Satisfaction below)
  + Ad Type Bonus               (TBD — to be specified when ad system is finalized)
  − Availability Penalty        (sell-outs reduce share via customer defection)
```

**Satisfaction Modifier** (primary driver — from the Satisfaction → Foot Traffic table):

| Avg Satisfaction % | Modifier |
|---|---|
| 0–20% | −40% |
| 21–45% | −20% |
| 46–65% | ±0% |
| 66–85% | +20% |
| 86–100% | +40% |

Premium bonus: +10% if Croissant or Matcha individually at Excellent (stackable, max +20%).

**Product Variety Bonus:**

| Products Offered | Bonus |
|---|---|
| 3 (base menu) | ±0% |
| 4 | +5% |
| 5 | +10% |
| 6 | +15% |

**Sous Chef Bonus** — applies only up to the optimal threshold (beyond threshold, Chef Satisfaction Score penalizes throughput instead — see below):

| Sous Chefs Hired | Foot Traffic Bonus |
|---|---|
| 0 | ±0% |
| 1 | +5% |
| 2 | +10% |
| 3 | +14% |
| 4 (threshold) | +17% |
| 5+ | No additional bonus — Chef Satisfaction penalty applies |

**Availability Penalty:** Each sell-out event during the round reduces foot traffic by −8% (product-loyal customers defect to competitors). Stacks per product sold out.

**Ad Type Bonus:** To be defined when the ad auction system is finalized.

### How Players Compete

The shared customer pool is zero-sum at the margin. Each player's base traffic share is proportional to their relative satisfaction score per product (see Competitive Foot Traffic Allocation). The foot traffic modifier above then scales each player's allocated share up or down based on their operational decisions.

Players must differentiate — if multiple players pursue the same product strategy, foot traffic splits by satisfaction dominance rather than accumulating for both.

### Preventing Dominant Strategy

Three mechanisms:

1. **Model noise** — a random component in revenue computation means the "optimal" inputs shift slightly each round
2. **Competitive allocation** — your revenue depends on what others do, not just your own decisions. There's no fixed optimal strategy.
3. **Information asymmetry** — players only see their own data. They can observe the leaderboard but not competitors' decisions. This prevents pure copycat strategies.

---

## Data Requirements

After each round, players receive a downloadable CSV of new rows. Players accumulate data over rounds and can download it as CSV/XLSX to build models in their own environment.

**Decision inputs (what the player controls):**

| Column | Type | Description |
|---|---|---|
| round | int | Round number (1–5) |
| num_products | int | Number of products on the menu that round |
| sous_chef_count | int | Total sous chefs hired that round |
| ad_type | char | Ad type won at auction (TV, Radio, Newspaper, Billboard, or None) |
| specialty_chef_1_nationality | char | Nationality of specialty chef in slot 1 (or None) |
| specialty_chef_1_skill | char | Skill tier of specialty chef in slot 1 (Novel / Intermediate / Advanced / None) |
| specialty_chef_2_nationality | char | Nationality of specialty chef in slot 2 (or None) |
| specialty_chef_2_skill | char | Skill tier of specialty chef in slot 2 |
| specialty_chef_3_nationality | char | Nationality of specialty chef in slot 3 (or None) |
| specialty_chef_3_skill | char | Skill tier of specialty chef in slot 3 |
| croissant_qty_stocked | int | Units of Croissant purchased this round |
| cookie_qty_stocked | int | Units of Cookie purchased this round |
| bagel_qty_stocked | int | Units of Bagel purchased this round |
| sandwich_qty_stocked | int | Units of Sandwich purchased this round (0 if not on menu) |
| coffee_qty_stocked | int | Units of Coffee purchased this round (0 if not on menu) |
| matcha_qty_stocked | int | Units of Matcha purchased this round (0 if not on menu) |

**Output results (what the game returns):**

| Column | Type | Description |
|---|---|---|
| revenue | float | TARGET VARIABLE — net revenue for the round ($). Gross revenue minus loan shark deduction (principal + interest) if applicable. This is the actual amount added to the player's budget balance. |
| amount_borrowed | float | Amount borrowed from the loan shark this round ($0 if spending did not exceed budget) |
| interest_charged | float | Interest charged on borrowed amount this round (amount_borrowed × 10%; $0 if nothing borrowed) |
| customer_count | int | Customers who visited and made a purchase |
| returning_customers | int | Customers from prior round's brand loyalty bonus (not in regression — results screen only) |
| aggregate_satisfaction_pct | float | Weighted average satisfaction across all products offered (0–100%). Weights: Coffee 1.5×, Matcha 1.3×, Croissant 1.2×, Sandwich/Cookie/Bagel 1.0×. |
| chef_satisfaction_score | int | Kitchen cohesion score (0–100) — penalizes excess sous chefs |
| croissant_satisfaction_pct | float | Per-product satisfaction % (0–100%) |
| cookie_satisfaction_pct | float | Per-product satisfaction % |
| bagel_satisfaction_pct | float | Per-product satisfaction % |
| sandwich_satisfaction_pct | float | Per-product satisfaction % (null if not offered) |
| coffee_satisfaction_pct | float | Per-product satisfaction % (null if not offered) |
| matcha_satisfaction_pct | float | Per-product satisfaction % (null if not offered) |
| croissant_qty_sold | int | Units sold |
| cookie_qty_sold | int | Units sold |
| bagel_qty_sold | int | Units sold |
| sandwich_qty_sold | int | Units sold (0 if not offered) |
| coffee_qty_sold | int | Units sold (0 if not offered) |
| matcha_qty_sold | int | Units sold (0 if not offered) |
| sellout_croissant | bool | 1 if sold out mid-round, 0 otherwise |
| sellout_cookie | bool | 1 if sold out mid-round |
| sellout_bagel | bool | 1 if sold out mid-round |
| sellout_sandwich | bool | 1 if sold out mid-round |
| sellout_coffee | bool | 1 if sold out mid-round |
| sellout_matcha | bool | 1 if sold out mid-round |

### Dataset Structure

Time series × multiple bakeries. Example:

```
Day 1  Bakery A  [feature inputs…]
Day 1  Bakery B  [feature inputs…]
Day 2  Bakery A  [feature inputs…]
Day 2  Bakery B  [feature inputs…]
```

Students can run a regression in Excel or Python using the set variables. Players are intended to receive the CSV file 1 week in advance to prep their models for gameplay.

**Backend deliverable:** a CSV containing the player's new data after each round iteration.

---

## MVP Scope — What Must Work for Launch

Minimum set of features needed to play one complete game session. Everything below must work. Everything above the cut line is a bonus.

- [ ] 1 — Player joins a game session (simple auth + lobby screen)
- [ ] 2 — Player builds their bakery: review pre-set starting budget, pre-set fixed prices, current sous chef count, and base menu (budget and prices are pre-disposed — not player inputs)
- [ ] 3 — For each new round: player sets quantity per product, sous chef count, and ad/chef bid amounts
- [ ] 4 — Player submits decisions before timer expires
- [ ] 5 — Backend runs regression model → computes revenue + customer allocation
- [ ] 6 — Player sees round results + leaderboard ranking
- [ ] 7 — Player downloads their new data as CSV
- [ ] 8 — Repeat for 5 rounds
- [ ] 9 — Professor can start, advance, pause, and end the game
- [ ] 10 — After Round 5, display Conclusion Screen: final rankings, net revenue, amount borrowed, interest charged, budget remaining (tiebreaker), and winner banner with full chef roster portraits

---

## Deferred from Design Deck

The following features from the original design deck are cut from v1. They can be added incrementally after the core loop works and is stable. This is not a rejection of these ideas — it's a sequencing decision.

| Feature | Status | Notes |
|---|---|---|
| Ad auction (sealed bid) | ✅ In v1 | 1-min sealed bid for TV, Radio, Newspaper, Billboard |
| Chef auction (sealed bid) | ✅ In v1 | 1-min sealed bid with nationality/skill shown, specialty hidden |
| Chef roster management | ✅ In v1 | Post-auction screen — lay-off flow, sous chef hiring |
| Chef satisfaction / "too many cooks" | ✅ In v1 | Score (0–100), threshold at 4 sous chefs, throughput multiplier |
| Fixed product pricing | ✅ In v1 (MVP simplification) | Per-product dynamic pricing is post-MVP |
| Per-product dynamic pricing | Post-MVP | Add after core loop is stable — high strategic value |
| Named customer archetypes | Post-MVP | Six archetypes (Morning Regular, Brunch Seeker, Wellness Shopper, Lunch Crowd, Sweet Tooth, Deal Hunter) with per-product loyalty and price sensitivity — add once dynamic pricing is in place |
| Sous chef poaching | Post-MVP | Complex real-time flow; requires notifications, counter-offers |
| 6 curveball / market events | Post-MVP | Each needs custom logic; start with 0, add 1–2 if time |
| AI competitors (3 tiers) | Post-MVP | Each tier needs heuristic logic — passive AI only if time |
| In-game chat + achievements | Not planned | Use Discord/Slack for communication |
| Supplier product drops | Not planned | Fixed products for v1 |
| Equipment upgrade tiers | Post-MVP | Consider after dynamic pricing is in |
| 12 products | Post-MVP | Current 6 is sufficient for launch |

---

## Regression Model — Starter Coefficients

Backend needs concrete coefficients to build the revenue engine. Placeholder model to start coding against. Game Design should refine these based on the professor's dataset and balance testing.

```
revenue = 500
        + (12 × sous_chef_count)
        + (8.0 × aggregate_satisfaction_pct)
        + (0.8 × ad_spend)
        + (50 × num_products)
        + (customer_count × product_revenue_rate)
        + noise
```

- **Base revenue:** $500/round just for being open
- **Sous chef count:** Each sous chef adds ~$12 direct revenue contribution. The sous chef coefficient is intentionally low — the real value of sous chefs is throughput, which flows through aggregate_satisfaction_pct. Hiring beyond the threshold (4) triggers the Chef Satisfaction throughput multiplier, which reduces satisfaction % and therefore that term dominates any gain from additional sous chefs.
- **Aggregate satisfaction %:** Each percentage point adds $8 to revenue — the primary driver. This is where chef investment, supply alignment, and kitchen efficiency all converge.
- **Ad spend:** Positive but sub-linear return (TBD — coefficient will adjust once ad types are finalized)
- **Num products:** Each additional menu item adds ~$50 through broader appeal
- **Customer count × product revenue rate:** `product_revenue_rate` = the fixed price of the product being sold. Since pricing is fixed per product, this term represents units sold × their fixed price. Products that are more expensive to sell (Sandwich $8.75, Matcha $6.25) also cost more to stock — the margin tradeoff is built into supply decisions.
- **Noise:** Random uniform ±$100 to prevent deterministic optimization. Chef satisfaction penalty flows through throughput → satisfaction %, not as a separate regression term.

> ⚠️ These are PLACEHOLDER coefficients. Backend will code against this structure and swap in final values. `avg_price` removed — pricing is fixed per product for MVP. `chef_satisfaction_score` removed from regression — its effect is captured entirely through the throughput multiplier → satisfaction % pathway.

---

## Starting Conditions (Confirmed — All-Hands April 8)

Same starting point for everyone. Same base-level sous chef count, same menu, same budget. No advantages at the start. Differentiation comes purely from decisions made during the game.

## Budget Rules (Confirmed — All-Hands April 8)

- Budget is set at a fixed amount (TBD — exact number to be finalized).
- Players spend across products, sous chef hiring, and auction bids.
- **Overbidding is allowed** — players are never blocked from exceeding their budget.
- **No in-game budget tracker during active play.** Players must track their own finances externally (Excel, paper, etc.). This is intentional — financial self-management is part of the challenge and mirrors real business operations. The game UI will never display remaining balance mid-round. Budget Remaining is revealed once, on the Conclusion Screen at the end of Round 5.

### Loan Shark Mechanic (Confirmed — April 15)

When a player's total round spending exceeds their available budget, the shortfall is treated as a loan from the loan shark.

**Penalty applied at end of round:**

```
Revenue deduction = borrowed amount + (10% × borrowed amount)
                  = borrowed amount × 1.10
```

- **Principal** (full borrowed amount) is deducted from revenue.
- **Interest** (10% of the borrowed amount) is deducted on top of principal.
- The penalty is applied before cumulative revenue is updated.
- Players are **not warned** mid-round — the deduction appears in the post-round revenue report.

**Example:** Player has $500 remaining budget but spends $700. Borrowed = $200. End-of-round deduction = $200 + $20 = **$220**.

> This resolves Open Question #6 (credit cost rate). Overspending is an option, not a safety net — the 10% interest makes it a net-negative strategy unless the incremental revenue from the overspend outpaces the penalty.

## Open Questions

1. ~~**Customer allocation formula:** How exactly are customers split?~~
   → ✅ **Resolved:** Proportional to weighted satisfaction score per product. See Base Traffic Pool and Competitive Foot Traffic Allocation sections.

2. ~~**Starting conditions:** Does everyone start identical (same budget, same menu, same sous chef count)? Or is there variation?~~
   → ✅ **Resolved:** Everyone starts the same. Same base-level sous chef count, same menu, same budget. (All-hands April 8)

3. ~~**Budget replenishment:** Do players get new budget each round, or is it cumulative from revenue? If cumulative, early mistakes compound — is that intended?~~
   → ✅ **Resolved:** Cumulative. Overbidding allowed with credit at a cost. (All-hands April 8)

4. **Which ONE feature from the cut list is highest priority if we have extra time?**
   → Recommend: 1 simple curveball event OR passive AI competitor, not both.

5. **Exact starting budget amount?** — Needs to be finalized.

6. ~~**Credit cost rate?** — What interest/penalty applies when players overbid beyond their budget?~~
   → ✅ **Resolved:** Loan shark mechanic — borrowed amount × 1.10 deducted from end-of-round revenue (principal + 10% interest). (April 15)

7. ~~**Staffing price escalation curve?**~~ → ✅ **Resolved:** Sous chef cost escalates per additional hire per round: 1.0×, 1.5×, 2.25×, 3.0×, +0.75× per additional. See Sous Chef section.

---

---

## Staff Tab UI

*Added April 17, 2026 — replaces the single sous chef stepper.*

The Staff Tab in the Decide phase sidebar is redesigned to reflect station-based hiring and the new Maintenance Guy role.

### Layout

The right side of the Staff Tab shows **four independent +/− hiring selectors**, one per staffing category:

| Selector | Label | What it controls |
|---|---|---|
| 1 | Sous Chef — Bakery Station | Sous chefs assigned to Oven station (Croissant, Cookie) |
| 2 | Sous Chef — Deli | Sous chefs assigned to Deli station (Bagel, Sandwich) |
| 3 | Sous Chef — Barista Station | Sous chefs assigned to Espresso Machine station (Coffee, Matcha) |
| 4 | Maintenance Guy | Maintenance staff (cleaning + machine repair) |

Each selector shows:
- Current count
- Cost for next hire (escalating)
- Running cost contribution to the total spend display

### Visual Staff Representation (Left Panel)

The left panel of the Staff Tab renders **pixel-art character assets** corresponding to the current staff count. As the player increases or decreases counts using the +/− selectors, characters appear or disappear in real-time.

**Sous chefs** are grouped by their assigned station — shown in front of their respective station area (oven, deli counter, espresso machine).

**Maintenance Guys** have a **dedicated standalone visualization zone**: a tiled floor section with a mop bucket asset. As the player hires more Maintenance Guys, additional character sprites appear in this zone standing beside or near the mop bucket. The tiled floor pattern distinguishes this zone visually from the cooking stations.

> **Asset requirement:** A pixel-art Maintenance Guy sprite and a mop bucket prop asset are needed. Style should match the existing `barista-walk-spritesheet.svg` and `chef-walk-spritesheet.svg` in `assets/svg/characters/`. The Maintenance Guy should wear a janitor uniform (coveralls or apron, bucket hat or cap), distinct from the chef coat/apron silhouette.

### Maintenance Assignment Panel

Below the Maintenance Guy count selector, a second sub-panel shows **task assignment** for each Maintenance Guy hired. Each hired Maintenance Guy gets a dropdown or toggle row:

```
Maintenance Guy 1: [Clean Store ▼]
Maintenance Guy 2: [Repair Espresso Machine ▼]
Maintenance Guy 3: [Repair Oven ▼]
```

Task options: Clean Store / Repair Oven / Repair Meat Slicer / Repair Espresso Machine.

A Maintenance Guy with no task assigned defaults to **Clean Store**.

### Maintenance Status Bars

Four status bars are always visible in the Staff Tab (read-only, not interactive):

```
Cleanliness        [████████░░] 82%
Oven Health        [█████░░░░░] 54%
Meat Slicer Health [███████░░░] 72%
Espresso Machine   [██░░░░░░░░] 23%  ⚠
```

Bars below 30% display a warning icon (⚠) to prompt player action.

---

## Next Steps

| Date | Task | Owner |
|---|---|---|
| April 3 | Game Design delivers final game config doc (all numbers, coefficients, starting conditions, budget rules) | Game Design |
| April 3 | Game Design + Backend agree on Firestore schema | Game Design + Backend |
| April 4 | Backend starts building auth + round state machine | Backend |
| April 4 | Frontend starts building lobby + decision dashboard | Frontend |
| April 10 | First end-to-end playable demo — one round, ugly, but functional | All |

---

## Implementation Tasks — Maintenance System & Station Architecture

*Added April 17, 2026. Tasks are split by team so each AI agent can operate independently.*

---

### 🖥️ FRONTEND TASKS

---

#### FE-1 — Rename all "cook" references to "sous chef"

**Files to touch:**
- `app/src/components/game/tabs/StaffTab.tsx` — rename any "cook" label text
- `app/src/types/game.ts` — rename any type fields referencing `cook` to `sousChef`
- `app/src/contexts/GameContext.tsx` — update any state fields or action types using "cook"
- Search the entire `app/src/` directory for the string `"cook"` (case-insensitive) and update all display strings

**Do not change:** Chef auction logic, specialty chef field names in backend schema (coordinate with backend if type names change in Firestore)

---

#### FE-2 — Rebuild StaffTab with 4 independent +/− selectors

**File:** `app/src/components/game/tabs/StaffTab.tsx`

Replace the existing single sous chef stepper with four separate stepper components:

1. **Sous Chef — Bakery Station** (Croissant, Cookie)
2. **Sous Chef — Deli** (Bagel, Sandwich)
3. **Sous Chef — Barista Station** (Coffee, Matcha)
4. **Maintenance Guy**

Each selector row shows:
- Station/role label with station icon or small product tags
- Current count
- Cost for next hire (escalating — use same curve as existing sous chef stepper: 1.0×, 1.5×, 2.25×, 3.0×, +0.75× per additional)
- Running sub-total cost for that role

The total staff cost display at the bottom should sum all four categories.

**State shape to add to `GameContext` or lift to `GamePage`:**
```ts
staffCounts: {
  bakerySousChefs: number;     // Bakery Station sous chefs
  deliSousChefs: number;       // Deli sous chefs
  baristaSousChefs: number;    // Barista Station sous chefs
  maintenanceGuys: number;     // Maintenance crew
}
```

**Remove:** The existing `staffCount` single integer from state after migrating all references.

---

#### FE-3 — Add Maintenance Guy task assignment UI

**File:** `app/src/components/game/tabs/StaffTab.tsx`

Below the Maintenance Guy count stepper, render a dynamic list of assignment rows — one row per Maintenance Guy hired. Each row shows:
- Label: "Maintenance Guy [n]"
- Dropdown or segmented toggle with 4 options:
  - Clean Store
  - Repair Oven (Bakery Station)
  - Repair Meat Slicer (Deli)
  - Repair Espresso Machine (Barista Station)

Default assignment: Clean Store for all. Rows appear/disappear as the player adds/removes Maintenance Guys.

**State to add:**
```ts
maintenanceTasks: Array<'clean' | 'repair_oven' | 'repair_slicer' | 'repair_espresso'>
```

Length must always equal `staffCounts.maintenanceGuys`.

---

#### FE-4 — Add 4 maintenance status bars to StaffTab

**File:** `app/src/components/game/tabs/StaffTab.tsx`

Add a read-only status section at the top of the Staff Tab that always shows current bar values pulled from the player's Firestore document (or GameContext if not yet connected to Firestore). Four bars:

1. **Cleanliness** — store-wide, driven by customer foot traffic
2. **Oven Health** — Bakery Station machine
3. **Meat Slicer Health** — Deli machine
4. **Espresso Machine Health** — Barista Station machine

Each bar renders as a labeled percentage progress bar matching the existing pixel-art CSS style (use existing `.bar` or `.progress` CSS patterns from `global.css`).

**Warning indicator:** If any bar is ≤ 30%, render a `⚠` warning icon beside it and apply a red/berry color tint (`var(--berry)`) to that bar. Do not block submission — this is informational only.

**Initial values** (when no Firestore data yet): all four bars at 100%.

---

#### FE-5 — Visual staff representation in the left panel

**File:** `app/src/components/game/BakeryView.tsx`

The left panel of the game view currently shows a static storefront with product shelves. Update it to render **pixel-art staff sprites** corresponding to the current staff count, grouped by zone:

- **Bakery Station zone** — render one sous chef sprite per `bakerySousChefs` count, positioned near/behind the bakery counter area
- **Deli zone** — render one sous chef sprite per `deliSousChefs`, near the deli counter
- **Barista Station zone** — render one sous chef sprite per `baristaSousChefs`, near the espresso machine area
- **Maintenance zone** — a dedicated strip at the bottom of the view showing a **tiled floor pattern** and a **mop bucket asset**. Render one Maintenance Guy sprite per `maintenanceGuys` count, standing near the mop bucket.

**Sprite behavior:**
- Sprites should use existing character spritesheet assets from `assets/svg/characters/`
- As count increases beyond available space, sprites should stack slightly (overlapping at ~30%) rather than overflow the container
- Min display: 0 sprites (empty zone). Max display: cap visual render at 5 sprites per zone to prevent overflow — show "+N more" text if count exceeds 5

**New asset needed:** Request a Maintenance Guy sprite and mop bucket prop from the art team. Reference the style guide at `assets/svg/_STYLE.md`. Placeholder: use the `customer-walk-spritesheet.svg` until the real asset exists.

---

#### FE-6 — Update `pendingDecision` submission payload

**File:** `app/src/pages/GamePage.tsx` (the submit handler)

When the player submits decisions, the Firestore write to `pendingDecision` must include the new staff fields:

```ts
pendingDecision: {
  // existing fields...
  staffCounts: {
    bakerySousChefs: number,
    deliSousChefs: number,
    baristaSousChefs: number,
    maintenanceGuys: number,
  },
  maintenanceTasks: string[],  // array of task assignments, length = maintenanceGuys
}
```

Remove the old flat `staffCount: number` field from the submission payload.

---

#### FE-7 — Update CSV download to include new columns

**File:** `app/src/components/game/RoundHeader.tsx` — `downloadResultsCsv` function

Add three new columns to the CSV output:
- `avg_cleanliness_pct`
- `avg_machine_health_pct`
- `maintenance_guy_count`

These values come from the player's round result object — source them from `GameContext.results` once the backend populates them.

---

#### FE-8 — Specialty chef satisfaction warning on Results screen

**File:** `app/src/pages/phases/ResultsPhase.tsx`

If any specialty chef's personal satisfaction score falls at or below 40% (warning threshold — before the 30% departure threshold), display a warning card on the results screen:

```
⚠ [Chef Name]'s satisfaction is low (XX%). Clean your kitchen to keep them.
```

If a chef actually departed that round (satisfaction reached 0% or fell below 30%), display a departure notice:

```
[Chef Name] has left the kitchen and re-entered the auction pool.
```

Source these values from the round result object passed down from `GameContext`.

---

### ⚙️ BACKEND TASKS

---

#### BE-1 — Update Firestore schema — PlayerDocument

**File:** `backend/firestore-schema.js`

Add the following fields to `PlayerDocument`:

```js
// Maintenance state (persists between rounds — never resets to 100% automatically)
cleanliness_pct: number,         // 0–100, starts at 100
oven_health_pct: number,         // 0–100, starts at 100
slicer_health_pct: number,       // 0–100, starts at 100
espresso_health_pct: number,     // 0–100, starts at 100

// Per-specialty-chef satisfaction (keyed by chefId)
chefSatisfactionScores: {
  [chefId: string]: number       // 0–100, starts at 100 when chef is acquired
},
```

Update `pendingDecision` shape to replace the old flat `staffCount` with the station-based structure:

```js
pendingDecision: {
  // ...existing fields...
  staffCounts: {
    bakerySousChefs: number,
    deliSousChefs: number,
    baristaSousChefs: number,
    maintenanceGuys: number,
  },
  maintenanceTasks: string[],    // ['clean', 'repair_oven', 'repair_slicer', 'repair_espresso']
}
```

---

#### BE-2 — Update Firestore security rules

**File:** `backend/firestore.rules`

Allow client writes to the new `staffCounts` and `maintenanceTasks` fields within `pendingDecision`. All four maintenance health bars (`cleanliness_pct`, `oven_health_pct`, `slicer_health_pct`, `espresso_health_pct`) must remain **read-only from the client** — updated only by Cloud Functions.

---

#### BE-3 — Update simulation engine — dirtiness degradation

**File:** `backend/functions/index.js` (simulation Cloud Function, when built)

After customer allocation resolves (total `customer_count` is known for the round):

```
new_cleanliness = max(0, current_cleanliness_pct − (customer_count × 3))
```

Then apply Maintenance Guy restoration for each guy assigned to "Clean Store":

```
clean_restoration = maintenanceGuys_assigned_clean × 15 × operational_hours_per_round
new_cleanliness = min(100, new_cleanliness + clean_restoration)
```

Write the final `cleanliness_pct` back to the player's document.

---

#### BE-4 — Update simulation engine — machine health degradation

**File:** `backend/functions/index.js`

After order quantities are resolved for the round, degrade each station's machine health:

```
new_oven_health = max(0, current_oven_health_pct − (croissant_qty_sold + cookie_qty_sold) × 2)
new_slicer_health = max(0, current_slicer_health_pct − (bagel_qty_sold + sandwich_qty_sold) × 2)
new_espresso_health = max(0, current_espresso_health_pct − (coffee_qty_sold + matcha_qty_sold) × 2)
```

Then apply Maintenance Guy restoration for each assigned task:

```
oven_restoration = maintenanceGuys_assigned_repair_oven × 15 × operational_hours
slicer_restoration = maintenanceGuys_assigned_repair_slicer × 15 × operational_hours
espresso_restoration = maintenanceGuys_assigned_repair_espresso × 15 × operational_hours

final_oven_health = min(100, new_oven_health + oven_restoration)
// same pattern for slicer and espresso
```

Write all three machine health fields back to the player's document.

---

#### BE-5 — Update throughput calculation — machine health penalty

**File:** `backend/functions/index.js`

Before calculating output for each station, apply the machine health multiplier:

```
function machineMultiplier(health_pct):
    if health_pct >= 71: return 1.0
    if health_pct >= 41: return 0.85    // Worn — −15%
    if health_pct >= 11: return 0.65    // Degraded — −35%
    return 0.50                          // Broken — −50%

bakery_throughput = calculated_bakery_output × machineMultiplier(oven_health_pct)
deli_throughput = calculated_deli_output × machineMultiplier(slicer_health_pct)
barista_throughput = calculated_barista_output × machineMultiplier(espresso_health_pct)
```

This penalty is applied before supply cap and before Chef Satisfaction Score multiplier.

---

#### BE-6 — Update Chef Satisfaction Score formula

**File:** `backend/functions/index.js`

Replace the existing formula with the updated version incorporating cleanliness:

```js
const overcrowding_penalty = Math.max(0, sous_chef_total - 4) * 16;
const cleanliness_bonus = cleanliness_pct * 0.10;   // max +10 at 100% clean
const chef_satisfaction_score = Math.min(100, Math.max(35, 100 - overcrowding_penalty + cleanliness_bonus));
```

`sous_chef_total` = `bakerySousChefs + deliSousChefs + baristaSousChefs` (not including Maintenance Guys).

---

#### BE-7 — Implement per-specialty-chef satisfaction decay and voluntary departure

**File:** `backend/functions/index.js`

At the end of each round, for each specialty chef on the player's roster:

**Station mapping per chef nationality (used for machine health bonuses/penalties):**
```js
const CHEF_STATIONS = {
  french:   ['bakery', 'barista'],   // Croissant (Oven), Coffee (Espresso Machine)
  japanese: ['barista', 'bakery'],   // Matcha (Espresso Machine), Croissant (Oven)
  italian:  ['deli', 'barista'],     // Sandwich (Meat Slicer), Coffee (Espresso Machine)
  american: ['deli', 'bakery'],      // Bagel (Meat Slicer), Cookie (Oven)
};
const STATION_HEALTH = {
  bakery:  oven_health_pct,
  deli:    slicer_health_pct,
  barista: espresso_health_pct,
};
// Primary station = worst-health station among the chef's stations
const chef_stations = CHEF_STATIONS[chef.nationality];
const primary_station_health = Math.min(...chef_stations.map(s => STATION_HEALTH[s]));
const any_machine_below_40 = Object.values(STATION_HEALTH).some(h => h < 40);
```

**1. Apply decay:**
```js
const decay_rates = { novel: 8, intermediate: 14, advanced: 20 };
const base_decay = decay_rates[chef.skill_level];

const dirty_penalty         = cleanliness_pct < 30        ? 5 : 0;
const chaos_penalty         = sous_chef_total >= 7         ? 5 : 0;
const broken_machine_penalty= any_machine_below_40         ? 5 : 0;
const primary_broken_penalty= primary_station_health < 20  ? 8 : 0;

new_satisfaction = current_satisfaction
  - base_decay
  - dirty_penalty
  - chaos_penalty
  - broken_machine_penalty
  - primary_broken_penalty;
```

**2. Apply recovery bonuses:**
```js
const cleanliness_recovery = cleanliness_pct > 90 ? 10
                           : cleanliness_pct > 70 ? 5 : 0;
const orderly_bonus        = sous_chef_total <= 4  ? 3 : 0;
const machines_ok_bonus    = Object.values(STATION_HEALTH).every(h => h > 70) ? 3 : 0;
const primary_excellent    = primary_station_health > 90 ? 5 : 0;

new_satisfaction = new_satisfaction
  + cleanliness_recovery
  + orderly_bonus
  + machines_ok_bonus
  + primary_excellent;

new_satisfaction = Math.max(0, Math.min(100, new_satisfaction));
```

**3. Check departure threshold:**
```js
if (new_satisfaction <= 30) {
  // Remove chef from player's specialty slots
  // Add chef back to the game's auction pool for next round
  // Log departure event to player's lastRoundResult for frontend display
}
```

Write updated `chefSatisfactionScores` to the player's Firestore document. Write any departure events to `lastRoundResult.chefDepartures[]`.

---

#### BE-8 — Update sous chef output calculation to use station assignments

**File:** `backend/functions/index.js`

Replace the existing flat `sous_chef_count` with station-specific counts:

```js
const bakery_sous_chefs = pendingDecision.staffCounts.bakerySousChefs;
const deli_sous_chefs = pendingDecision.staffCounts.deliSousChefs;
const barista_sous_chefs = pendingDecision.staffCounts.baristaSousChefs;

// Output contribution per sous chef = 0.5 × head chef's output on that station's products
bakery_sous_chef_output = bakery_sous_chefs × 0.5 × head_chef_bakery_output;
deli_sous_chef_output = deli_sous_chefs × 0.5 × head_chef_deli_output;
barista_sous_chef_output = barista_sous_chefs × 0.5 × head_chef_barista_output;
```

"Head chef" for each station = the highest-skill specialty chef with a specialty in any product at that station. If no specialty chef covers that station, use the base chef's output.

---

#### BE-9 — Update CSV export with new columns

**File:** `backend/functions/index.js` (CSV generation function, when built)

Add to the per-round CSV row:

| Column | Source |
|---|---|
| `avg_cleanliness_pct` | `cleanliness_pct` at end of round |
| `avg_machine_health_pct` | Average of `oven_health_pct`, `slicer_health_pct`, `espresso_health_pct` at end of round |
| `maintenance_guy_count` | `staffCounts.maintenanceGuys` from `pendingDecision` |

Also split `sous_chef_count` in the CSV into three columns:
- `bakery_sous_chef_count`
- `deli_sous_chef_count`
- `barista_sous_chef_count`

---

#### BE-10 — Update game config / seed data

**File:** `backend/seed/local-game.json`

Add new config parameters under `config/params`:

```json
{
  "operationalHoursPerRound": 8,
  "maintenanceRestoreRatePerHour": 15,
  "dirtinessDropPerCustomer": 3,
  "machineHealthDropPerOrder": 2,
  "chefDepartureThreshold": 30,
  "chefSatisfactionDecayRates": {
    "novel": 8,
    "intermediate": 14,
    "advanced": 20
  },
  "machineHealthMultipliers": {
    "optimal": 1.0,
    "worn": 0.85,
    "degraded": 0.65,
    "broken": 0.50
  }
}
```

Update `seed/local-game.json` with initial player state showing all four maintenance bars at 100%.