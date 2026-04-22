/**
 * csv-export.js — CSV generation for round-by-round game data.
 *
 * Pure module (no Firebase dependencies). CommonJS exports only.
 *
 * A "roundResult" is the object produced by the simulation for a single
 * player-round. It is expected to contain (at minimum):
 *
 *   round                      number
 *   decision: {
 *     menu:        { [product]: boolean },
 *     quantities:  { [product]: number },
 *     sousChefCount: number,
 *     adBids:      { [adType]: number }  (optional, from bids phase)
 *   }
 *   specialtyChefs: [{ nationality, skillTier }, ...]   // up to 3
 *   revenueGross              number
 *   amountBorrowed            number
 *   interestCharged           number
 *   customerCount             number
 *   aggregateSatisfactionPct  number
 *   chefSatisfactionScore     number
 *   perProductSatisfaction:   { [product]: number }
 *   perProductSold:           { [product]: number }
 *   selloutFlags:             { [product]: boolean }
 *
 * Fields may be missing on rounds where a product wasn't offered; this module
 * renders those as blank cells (null).
 */

const { PRODUCT_KEYS, AD_TYPES } = require('./config');

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/** Product key order used for per-product columns. */
const CSV_PRODUCT_ORDER = ['croissant', 'cookie', 'bagel', 'sandwich', 'coffee', 'matcha'];

/**
 * CSV_COLUMNS
 * Ordered array of column definitions:
 *   { key:    unique column identifier,
 *     header: column header in the CSV,
 *     type:   'int' | 'float' | 'pct' | 'bool' | 'string' }
 *
 * 38+ columns covering decision inputs followed by simulation outputs.
 */
const CSV_COLUMNS = [
  // --- Decision inputs ---
  { key: 'round',           header: 'round',           type: 'int'    },
  { key: 'num_products',    header: 'num_products',    type: 'int'    },
  { key: 'sous_chef_count', header: 'sous_chef_count', type: 'int'    },
  { key: 'ad_type',         header: 'ad_type',         type: 'string' },

  { key: 'specialty_chef_1_nationality', header: 'specialty_chef_1_nationality', type: 'string' },
  { key: 'specialty_chef_1_skill',       header: 'specialty_chef_1_skill',       type: 'string' },
  { key: 'specialty_chef_2_nationality', header: 'specialty_chef_2_nationality', type: 'string' },
  { key: 'specialty_chef_2_skill',       header: 'specialty_chef_2_skill',       type: 'string' },
  { key: 'specialty_chef_3_nationality', header: 'specialty_chef_3_nationality', type: 'string' },
  { key: 'specialty_chef_3_skill',       header: 'specialty_chef_3_skill',       type: 'string' },

  { key: 'croissant_qty_stocked', header: 'croissant_qty_stocked', type: 'int' },
  { key: 'cookie_qty_stocked',    header: 'cookie_qty_stocked',    type: 'int' },
  { key: 'bagel_qty_stocked',     header: 'bagel_qty_stocked',     type: 'int' },
  { key: 'sandwich_qty_stocked',  header: 'sandwich_qty_stocked',  type: 'int' },
  { key: 'coffee_qty_stocked',    header: 'coffee_qty_stocked',    type: 'int' },
  { key: 'matcha_qty_stocked',    header: 'matcha_qty_stocked',    type: 'int' },

  { key: 'croissant_price', header: 'croissant_price', type: 'float' },
  { key: 'cookie_price',    header: 'cookie_price',    type: 'float' },
  { key: 'bagel_price',     header: 'bagel_price',     type: 'float' },
  { key: 'sandwich_price',  header: 'sandwich_price',  type: 'float' },
  { key: 'coffee_price',    header: 'coffee_price',    type: 'float' },
  { key: 'matcha_price',    header: 'matcha_price',    type: 'float' },

  // --- Outputs ---
  { key: 'revenue',                  header: 'revenue',                  type: 'float' },
  { key: 'amount_borrowed',          header: 'amount_borrowed',          type: 'float' },
  { key: 'interest_charged',         header: 'interest_charged',         type: 'float' },
  { key: 'customer_count',           header: 'customer_count',           type: 'int'   },
  { key: 'aggregate_satisfaction_pct', header: 'aggregate_satisfaction_pct', type: 'pct' },
  { key: 'chef_satisfaction_score',  header: 'chef_satisfaction_score',  type: 'float' },

  { key: 'croissant_satisfaction_pct', header: 'croissant_satisfaction_pct', type: 'pct' },
  { key: 'cookie_satisfaction_pct',    header: 'cookie_satisfaction_pct',    type: 'pct' },
  { key: 'bagel_satisfaction_pct',     header: 'bagel_satisfaction_pct',     type: 'pct' },
  { key: 'sandwich_satisfaction_pct',  header: 'sandwich_satisfaction_pct',  type: 'pct' },
  { key: 'coffee_satisfaction_pct',    header: 'coffee_satisfaction_pct',    type: 'pct' },
  { key: 'matcha_satisfaction_pct',    header: 'matcha_satisfaction_pct',    type: 'pct' },

  { key: 'croissant_qty_sold', header: 'croissant_qty_sold', type: 'int' },
  { key: 'cookie_qty_sold',    header: 'cookie_qty_sold',    type: 'int' },
  { key: 'bagel_qty_sold',     header: 'bagel_qty_sold',     type: 'int' },
  { key: 'sandwich_qty_sold',  header: 'sandwich_qty_sold',  type: 'int' },
  { key: 'coffee_qty_sold',    header: 'coffee_qty_sold',    type: 'int' },
  { key: 'matcha_qty_sold',    header: 'matcha_qty_sold',    type: 'int' },

  { key: 'sellout_croissant', header: 'sellout_croissant', type: 'bool' },
  { key: 'sellout_cookie',    header: 'sellout_cookie',    type: 'bool' },
  { key: 'sellout_bagel',     header: 'sellout_bagel',     type: 'bool' },
  { key: 'sellout_sandwich',  header: 'sellout_sandwich',  type: 'bool' },
  { key: 'sellout_coffee',    header: 'sellout_coffee',    type: 'bool' },
  { key: 'sellout_matcha',    header: 'sellout_matcha',    type: 'bool' },
];

/**
 * PROFESSOR_EXTRA_COLUMNS
 * Extra identifying columns prepended for the professor export.
 */
const PROFESSOR_EXTRA_COLUMNS = [
  { key: 'player_id',    header: 'player_id',    type: 'string' },
  { key: 'bakery_name',  header: 'bakery_name',  type: 'string' },
  { key: 'display_name', header: 'display_name', type: 'string' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the first non-null/undefined value from the argument list. Treats NaN
 * as missing as well.
 */
function firstDefined(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    return v;
  }
  return null;
}

/**
 * Derive the "primary" ad type for the legacy `ad_type` column: the ad with
 * the highest non-zero bid, or '' if nothing was bid.
 */
function derivePrimaryAdType(adBids) {
  if (!adBids || typeof adBids !== 'object') return '';
  let best = null;
  let bestAmt = 0;
  for (const ad of AD_TYPES) {
    const amt = Number(adBids[ad]);
    if (Number.isFinite(amt) && amt > bestAmt) {
      bestAmt = amt;
      best = ad;
    }
  }
  return best || '';
}

/**
 * Format a cell value according to its declared type.
 * Returns '' for null/undefined so blank cells render cleanly.
 */
function formatCell(value, type) {
  if (value === null || value === undefined) return '';

  switch (type) {
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) return '';
      return String(Math.round(n));
    }
    case 'float': {
      const n = Number(value);
      if (!Number.isFinite(n)) return '';
      // Two decimal places is plenty for money / satisfaction.
      return (Math.round(n * 100) / 100).toString();
    }
    case 'pct': {
      const n = Number(value);
      if (!Number.isFinite(n)) return '';
      return (Math.round(n * 10) / 10).toString();
    }
    case 'bool':
      return value ? 'true' : 'false';
    case 'string':
    default:
      return String(value);
  }
}

/**
 * Escape a single CSV cell per RFC 4180.
 * Wraps in quotes if the value contains a comma, quote, or newline.
 */
function csvEscape(cell) {
  const s = cell == null ? '' : String(cell);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// buildCsvRow
// ---------------------------------------------------------------------------

/**
 * buildCsvRow
 * Flattens a simulation roundResult into a flat object keyed by CSV column
 * keys. Fields for products not offered are set to null (rendered as blank).
 *
 * @param {object} roundResult
 * @returns {object} flat row keyed by CSV column keys
 */
function buildCsvRow(roundResult) {
  const r = roundResult || {};
  const decision = r.decision || {};
  const menu = decision.menu || {};
  const quantities = decision.quantities || {};
  const adBids = decision.adBids || r.adBids || {};
  const specialtyChefs = Array.isArray(r.specialtyChefs) ? r.specialtyChefs : [];
  const perProductSat = r.perProductSatisfaction || {};
  const perProductSold = r.perProductSold || {};
  const sellout = r.selloutFlags || {};

  const row = {};

  // Decision inputs
  row.round = firstDefined(r.round, decision.round);
  const numProducts = PRODUCT_KEYS.reduce((acc, p) => acc + (menu[p] ? 1 : 0), 0);
  row.num_products = firstDefined(decision.numProducts, numProducts);
  row.sous_chef_count = firstDefined(decision.sousChefCount, 0);
  row.ad_type = derivePrimaryAdType(adBids);

  // Up to 3 specialty chef slots
  for (let i = 0; i < 3; i++) {
    const chef = specialtyChefs[i] || {};
    row[`specialty_chef_${i + 1}_nationality`] = chef.nationality || '';
    row[`specialty_chef_${i + 1}_skill`] = chef.skillTier || chef.skill || '';
  }

  // Per-product quantities stocked. If not on menu, leave blank (null).
  for (const p of CSV_PRODUCT_ORDER) {
    const onMenu = !!menu[p];
    const qty = quantities[p];
    row[`${p}_qty_stocked`] = onMenu ? (qty == null ? 0 : qty) : null;
  }

  // Per-product prices. If not on menu or price is missing, leave blank (null).
  const productPrices = (r.productPrices) || {};
  for (const p of CSV_PRODUCT_ORDER) {
    const onMenu = !!menu[p];
    const price = productPrices[p];
    row[`${p}_price`] = (onMenu && Number.isFinite(price)) ? price : null;
  }

  // Outputs
  // Spec: revenue CSV column is NET (post loan-shark deduction).
  row.revenue                     = firstDefined(r.revenueNet, r.revenue, r.revenueGross);
  row.amount_borrowed             = firstDefined(r.amountBorrowed, 0);
  row.interest_charged            = firstDefined(r.interestCharged, 0);
  row.customer_count              = firstDefined(r.customerCount, 0);
  row.aggregate_satisfaction_pct  = firstDefined(r.aggregateSatisfactionPct);
  row.chef_satisfaction_score     = firstDefined(r.chefSatisfactionScore);

  for (const p of CSV_PRODUCT_ORDER) {
    const onMenu = !!menu[p];
    // perProductSat[p] may be a number (raw %) or an object { satisfactionPct, qtySold, sellout, ... }
    const satEntry = perProductSat[p];
    let satPct = null;
    let qtySold = null;
    let isSellout = null;
    if (onMenu && satEntry != null) {
      if (typeof satEntry === 'object') {
        satPct = satEntry.satisfactionPct != null ? satEntry.satisfactionPct : null;
        qtySold = satEntry.qtySold != null ? satEntry.qtySold : (perProductSold[p] || 0);
        isSellout = satEntry.sellout != null ? !!satEntry.sellout : !!sellout[p];
      } else {
        satPct = satEntry;
        qtySold = firstDefined(perProductSold[p], 0);
        isSellout = !!sellout[p];
      }
    }
    row[`${p}_satisfaction_pct`] = onMenu ? satPct : null;
    row[`${p}_qty_sold`]         = onMenu ? qtySold : null;
    row[`sellout_${p}`]          = onMenu ? isSellout : null;
  }

  return row;
}

// ---------------------------------------------------------------------------
// buildCsvString
// ---------------------------------------------------------------------------

/**
 * buildCsvString
 * Generate an RFC-4180-compliant CSV from an array of row objects.
 *
 * @param {object[]} rows rows produced by buildCsvRow (may be professor-augmented)
 * @param {boolean}  includeProfessorColumns prepend player_id/bakery_name/display_name
 * @returns {string} CSV text (ends with a trailing newline)
 */
function buildCsvString(rows, includeProfessorColumns = false) {
  const columns = includeProfessorColumns
    ? [...PROFESSOR_EXTRA_COLUMNS, ...CSV_COLUMNS]
    : CSV_COLUMNS;

  const headerLine = columns.map((c) => csvEscape(c.header)).join(',');
  const dataLines = (rows || []).map((row) =>
    columns
      .map((c) => csvEscape(formatCell(row[c.key], c.type)))
      .join(','),
  );

  return [headerLine, ...dataLines].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// buildFirestoreCsvRow
// ---------------------------------------------------------------------------

/**
 * buildFirestoreCsvRow
 * Same flat shape as buildCsvRow, but massaged for Firestore storage:
 *   - null-valued "product not offered" fields are omitted (Firestore handles
 *     undefined cleanly when writing via admin SDK); they're set to null for
 *     explicit clarity.
 *   - a `columnOrder` field is included so downstream readers can reconstruct
 *     CSV output without importing this module.
 *
 * Intended for writes at `csvRows/{playerId}/rounds/{round}`.
 *
 * @param {object} roundResult
 * @returns {object}
 */
function buildFirestoreCsvRow(roundResult) {
  const row = buildCsvRow(roundResult);
  // Preserve column order alongside the data so the professor export job can
  // reassemble CSVs directly from Firestore if needed.
  return {
    ...row,
    columnOrder: CSV_COLUMNS.map((c) => c.key),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CSV_COLUMNS,
  PROFESSOR_EXTRA_COLUMNS,
  CSV_PRODUCT_ORDER,
  buildCsvRow,
  buildCsvString,
  buildFirestoreCsvRow,
  // Exposed for tests
  csvEscape,
  formatCell,
  derivePrimaryAdType,
};
