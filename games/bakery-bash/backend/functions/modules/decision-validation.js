/**
 * decision-validation.js — Validate decisions, ad bids, and chef bids.
 *
 * Pure module (no Firebase dependencies). CommonJS exports only.
 *
 * NEW decision schema (MVP — prices are fixed per config.PRODUCT_CATALOG):
 *
 *   menu: {
 *     croissant: true, cookie: true, bagel: true,        // base menu — always true
 *     sandwich:  bool, coffee:    bool, matcha: bool,     // optional
 *   }
 *   quantities: {
 *     croissant: int, cookie: int, bagel: int,
 *     sandwich:  int, coffee: int, matcha: int,
 *   }
 *   sousChefCount:       int (0+)
 *   sousChefAssignments: { [product]: int }  // sums to sousChefCount; keys ⊂ offered products
 *
 * Bids live in a separate submission (new schema):
 *
 *   adBids:   { TV:number, Billboard:number, Radio:number, Newspaper:number }
 *   chefBids: [{ chefId:string, amount:number }]
 */

const { PRODUCT_KEYS, BASE_MENU, OPTIONAL_MENU, AD_TYPES } = require('./config');

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

/**
 * ValidationError
 * HttpsError-shaped error with `code` and `message`. Pure JS (no firebase-functions).
 */
class ValidationError extends Error {
  /**
   * @param {string} code    Firebase-style code (e.g. 'invalid-argument')
   * @param {string} message human-readable message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.message = message;
  }
}

function fail(code, message) {
  throw new ValidationError(code, message);
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/**
 * Require a non-negative integer; throws ValidationError otherwise.
 * @param {*} value
 * @param {string} label
 * @returns {number}
 */
function requireNonNegInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    fail('invalid-argument', `${label} must be a non-negative integer (got ${value})`);
  }
  return n;
}

/**
 * Require a non-negative finite number; throws ValidationError otherwise.
 */
function requireNonNegNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    fail('invalid-argument', `${label} must be a non-negative number (got ${value})`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// validateDecision
// ---------------------------------------------------------------------------

/**
 * validateDecision
 * Validate and sanitize a raw decision submission.
 *
 * @param {object} data           raw decision payload
 * @param {number} currentRound   round number (stored on the sanitized output)
 * @param {object} _config        merged game config (unused here; reserved for future rules)
 * @param {object} [opts]         { unlockedProducts?: string[] } — Apr 28 2026:
 *   list of products the team has unlocked (always includes BASE_MENU starters).
 *   If a player tries to put an OPTIONAL_MENU product on the menu without
 *   having unlocked it, validation fails. When omitted (legacy callers / tests),
 *   defaults to BASE_MENU only — i.e., locked products are rejected.
 * @returns {object} sanitized decision:
 *   {
 *     round,
 *     menu:        { [product]: boolean },
 *     quantities:  { [product]: number },
 *     sousChefCount: number,
 *     sousChefAssignments: { [product]: number },
 *     numProducts: number,
 *   }
 * @throws {ValidationError} on any invalid field
 */
function validateDecision(data, currentRound, _config, opts) {
  if (!data || typeof data !== 'object') {
    fail('invalid-argument', 'Decision payload must be an object');
  }

  // Apr 28 2026 — station unlocks. Build a Set of products the team is
  // allowed to put on the menu. BASE_MENU is always allowed (starters);
  // OPTIONAL_MENU products must appear in `unlockedProducts`.
  const optsUnlocked = opts && Array.isArray(opts.unlockedProducts)
    ? opts.unlockedProducts
    : null;
  const allowedSet = new Set(BASE_MENU);
  if (optsUnlocked) {
    for (const p of optsUnlocked) {
      if (typeof p === 'string') allowedSet.add(p);
    }
  }

  // --- menu ---
  const rawMenu = data.menu && typeof data.menu === 'object' ? data.menu : {};
  const menu = {};
  for (const p of BASE_MENU) {
    // Base menu must be present and truthy.
    if (rawMenu[p] === false) {
      fail('invalid-argument', `Base product "${p}" cannot be disabled`);
    }
    menu[p] = true;
  }
  for (const p of OPTIONAL_MENU) {
    const requested = !!rawMenu[p];
    if (requested && !allowedSet.has(p)) {
      fail(
        'failed-precondition',
        `Product "${p}" is locked. Unlock it on the bakery view before adding it to the menu.`,
      );
    }
    menu[p] = requested;
  }

  const offeredProducts = PRODUCT_KEYS.filter((p) => menu[p]);

  // --- quantities ---
  const rawQtys = data.quantities && typeof data.quantities === 'object' ? data.quantities : {};
  const quantities = {};
  for (const p of PRODUCT_KEYS) {
    const raw = rawQtys[p];
    if (!menu[p]) {
      // Not offered → must be 0 (we accept missing/0, reject > 0).
      if (raw != null && raw !== '' && Number(raw) !== 0) {
        fail(
          'invalid-argument',
          `quantities.${p} must be 0 for products not on the menu (got ${raw})`,
        );
      }
      quantities[p] = 0;
    } else {
      // On menu → non-negative integer (defaults to 0 if missing).
      if (raw == null || raw === '') {
        quantities[p] = 0;
      } else {
        quantities[p] = requireNonNegInt(raw, `quantities.${p}`);
      }
    }
  }

  // --- sousChefCount ---
  // HIGH-11 fix: cap sous chefs at a reasonable maximum to prevent
  // accidental self-bankruptcy from absurd values.
  const MAX_SOUS_CHEFS = 20;
  const sousChefCount =
    data.sousChefCount == null || data.sousChefCount === ''
      ? 0
      : requireNonNegInt(data.sousChefCount, 'sousChefCount');
  if (sousChefCount > MAX_SOUS_CHEFS) {
    fail('invalid-argument', `sousChefCount (${sousChefCount}) exceeds maximum of ${MAX_SOUS_CHEFS}`);
  }

  // --- sousChefAssignments ---
  const rawAssign =
    data.sousChefAssignments && typeof data.sousChefAssignments === 'object'
      ? data.sousChefAssignments
      : {};
  const sousChefAssignments = {};
  let assignedSum = 0;
  for (const key of Object.keys(rawAssign)) {
    if (!PRODUCT_KEYS.includes(key)) {
      fail('invalid-argument', `sousChefAssignments has unknown product "${key}"`);
    }
    if (!menu[key]) {
      fail(
        'invalid-argument',
        `sousChefAssignments["${key}"]: cannot assign to a product not on the menu`,
      );
    }
    const n = requireNonNegInt(rawAssign[key], `sousChefAssignments.${key}`);
    if (n > 0) {
      sousChefAssignments[key] = n;
      assignedSum += n;
    }
  }
  if (assignedSum !== sousChefCount) {
    fail(
      'invalid-argument',
      `sousChefAssignments sum (${assignedSum}) must equal sousChefCount (${sousChefCount})`,
    );
  }

  return {
    round: Number.isFinite(Number(currentRound)) ? Number(currentRound) : null,
    menu,
    quantities,
    sousChefCount,
    sousChefAssignments,
    numProducts: offeredProducts.length,
  };
}

// ---------------------------------------------------------------------------
// validateAdBids
// ---------------------------------------------------------------------------

/**
 * validateAdBids
 * Validate ad-auction bids. Each of the four ad types accepts a non-negative
 * number (or absence = 0). Unknown keys are rejected.
 *
 * @param {object} data raw bid payload { adBids?: {...} } OR { TV:.., ... }
 * @returns {object} sanitized { TV, Billboard, Radio, Newspaper } (numbers)
 */
function validateAdBids(data) {
  if (!data || typeof data !== 'object') {
    fail('invalid-argument', 'Ad bids payload must be an object');
  }
  // Allow either { adBids: {...} } or bids at the top level.
  const raw = data.adBids && typeof data.adBids === 'object' ? data.adBids : data;

  const bids = {};
  for (const ad of AD_TYPES) {
    const v = raw[ad];
    if (v == null || v === '') {
      bids[ad] = 0;
    } else {
      bids[ad] = requireNonNegNumber(v, `adBids.${ad}`);
    }
  }

  // MED-07 fix: reject unknown keys, but whitelist protocol keys that may
  // appear in the raw payload when adBids was not wrapped in a sub-object.
  const KNOWN_NON_BID_KEYS = new Set(['adBids', 'gameId', 'bidType', 'round']);
  for (const key of Object.keys(raw)) {
    if (KNOWN_NON_BID_KEYS.has(key)) continue;
    if (!AD_TYPES.includes(key)) {
      fail('invalid-argument', `Unknown ad type in bids: "${key}"`);
    }
  }

  return bids;
}

// ---------------------------------------------------------------------------
// validateChefBids
// ---------------------------------------------------------------------------

/**
 * validateChefBids
 * Validate chef bids against the current chef pool. Each entry must reference
 * a chef in the pool and bid >= chef.minBidFloor (or be 0 to skip).
 *
 * @param {object|Array} data raw payload: `[{chefId, amount}, ...]` or `{ chefBids: [...] }`
 * @param {object[]}     chefPool array of chefs with { id (or chefId), minBidFloor }
 * @returns {Array<{chefId:string, amount:number}>} sanitized bids (zero-bids dropped)
 */
function validateChefBids(data, chefPool) {
  if (!data) {
    fail('invalid-argument', 'Chef bids payload must be present');
  }
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data.chefBids)
    ? data.chefBids
    : null;
  if (!Array.isArray(raw)) {
    fail('invalid-argument', 'Chef bids must be an array');
  }

  const pool = Array.isArray(chefPool) ? chefPool : [];
  const poolById = new Map();
  for (const c of pool) {
    const id = c && (c.id || c.chefId);
    if (id) poolById.set(id, c);
  }

  const seen = new Set();
  const out = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      fail('invalid-argument', 'Each chef bid must be an object');
    }
    const chefId = entry.chefId || entry.id;
    if (!chefId || typeof chefId !== 'string') {
      fail('invalid-argument', 'Each chef bid must include chefId');
    }
    if (seen.has(chefId)) {
      fail('invalid-argument', `Duplicate chef bid for "${chefId}"`);
    }
    seen.add(chefId);

    const chef = poolById.get(chefId);
    if (!chef) {
      fail('invalid-argument', `Chef "${chefId}" is not in the current pool`);
    }

    const amount = requireNonNegNumber(entry.amount, `chefBids[${chefId}].amount`);
    if (amount === 0) {
      // Skip — zero-bid means "not bidding on this chef."
      continue;
    }
    const floor = Number(chef.minBidFloor);
    if (Number.isFinite(floor) && amount < floor) {
      const chefIndex = pool.findIndex((candidate) => (candidate && (candidate.id || candidate.chefId)) === chefId);
      fail(
        'invalid-argument',
        `Your bid for Chef #${chefIndex >= 0 ? chefIndex + 1 : "?"} ($${amount.toLocaleString()}) is below the Minimum Ask of $${floor.toLocaleString()}.`,
      );
    }

    out.push({ chefId, amount });
  }

  return out;
}

// ---------------------------------------------------------------------------
// validateProductPrices (POST-01)
// ---------------------------------------------------------------------------

const {
  PRICE_ZONES,
} = require('./config');

const {
  snapPriceToStep,
  clampPrice,
} = require('./pricing');

/**
 * Validate and sanitize a per-product price map.
 * Returns a canonical object with every submitted product snapped to $0.25
 * and clamped to [floor, ceiling].
 *
 * @param {unknown} raw - { [product]: number } | null | undefined
 * @returns {object} canonical { [product]: number } (may be empty)
 * @throws {ValidationError} on unknown keys or non-number / non-positive / non-finite values
 */
function validateProductPrices(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object') {
    fail('invalid-argument', `productPrices must be an object (got ${typeof raw})`);
  }

  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!PRICE_ZONES[key]) {
      fail('invalid-argument', `productPrices has unknown product "${key}"`);
    }
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      fail('invalid-argument', `productPrices.${key} must be a finite positive number (got ${val})`);
    }
    out[key] = clampPrice(snapPriceToStep(val), PRICE_ZONES[key]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildDefaultDecision / buildDefaultBids
// ---------------------------------------------------------------------------

/**
 * buildDefaultDecision
 * Default pending decision for no-show players: base menu only, all qtys 0,
 * no sous chefs, no assignments.
 *
 * @param {object} _config (unused; kept for signature compatibility)
 * @returns {object} sanitized decision
 */
function buildDefaultDecision(_config) {
  const menu = {};
  for (const p of PRODUCT_KEYS) menu[p] = BASE_MENU.includes(p);

  const quantities = {};
  for (const p of PRODUCT_KEYS) quantities[p] = 0;

  return {
    round: null,
    menu,
    quantities,
    sousChefCount: 0,
    sousChefAssignments: {},
    numProducts: BASE_MENU.length,
    isDefault: true,
  };
}

/**
 * buildDefaultBids
 * Default empty bids (all ad types = 0, no chef bids).
 *
 * @returns {{ adBids: object, chefBids: Array }}
 */
function buildDefaultBids() {
  const adBids = {};
  for (const ad of AD_TYPES) adBids[ad] = 0;
  return {
    adBids,
    chefBids: [],
    isDefault: true,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ValidationError,
  validateDecision,
  validateAdBids,
  validateChefBids,
  validateProductPrices,
  buildDefaultDecision,
  buildDefaultBids,
  // Exposed for tests
  requireNonNegInt,
  requireNonNegNumber,
};
