/**
 * Decision validation contract tests. These pin invariants that
 * `submitDecision` in index.js relies on after spreading the validated
 * object into the persisted decisionPatch.
 */

const assert = require('node:assert/strict');
const {
  validateDecision,
  validateQuantitiesPayload,
} = require('../functions/modules/decision-validation');
const configMod = require('../functions/modules/config');

const config = {
  ...configMod,
  ...configMod.DEFAULT_GAME_CONFIG,
};

// BASE_MENU = croissant, bagel, coffee — always unlocked.
const baseInput = () => ({
  menu: { croissant: true, bagel: true, coffee: true },
  quantities: { croissant: 100, bagel: 100, coffee: 100 },
  sousChefCount: 0,
  sousChefAssignments: {},
});

describe('validateDecision staffCounts contract (PR #128)', () => {
  it('defaults staffCounts.maintenanceGuys to 0 when client omits the field', () => {
    // Barlava follow-up (2026-04-29): default flipped from 2 → 0 to
    // match the FE DEFAULT_STAFF_COUNTS. Players hire maintenance
    // explicitly now; no more "ghost" two-person starter staff.
    const validated = validateDecision(baseInput(), 1, config, {});
    assert.ok(validated.staffCounts, 'validated should include staffCounts');
    assert.equal(validated.staffCounts.maintenanceGuys, 0,
      'maintenanceGuys must default to 0 — submitDecision relies on this default ' +
      'flowing through the {...validated} spread into the persisted decisionPatch.');
  });

  it('preserves explicit staffCounts.maintenanceGuys from the client', () => {
    const validated = validateDecision(
      { ...baseInput(), staffCounts: { maintenanceGuys: 5 } },
      1, config, {},
    );
    assert.equal(validated.staffCounts.maintenanceGuys, 5);
  });

  it('survives the {...validated} spread used in submitDecision', () => {
    // This pins the pattern in index.js submitDecision: a decisionPatch is
    // built by spreading `validated`. Any explicit `staffCounts:` assignment
    // AFTER the spread would overwrite the defaulted value with the raw
    // client object — that is the bug PR #128 fixes.
    const validated = validateDecision(baseInput(), 1, config, {});
    const decisionPatch = {
      round: 1,
      submittedAt: 'sentinel',
      ...validated,
    };
    assert.equal(decisionPatch.staffCounts.maintenanceGuys, 0,
      'spread should carry through the validator default');
  });
});

describe('validateQuantitiesPayload (M-17)', () => {
  it('returns every PRODUCT_KEY with 0 default when input is null/empty', () => {
    const out = validateQuantitiesPayload(null);
    for (const p of configMod.PRODUCT_KEYS) {
      assert.equal(out[p], 0, `${p} should default to 0`);
    }
  });

  it('coerces stringy non-negative ints', () => {
    const out = validateQuantitiesPayload({ croissant: '50', bagel: 25 });
    assert.equal(out.croissant, 50);
    assert.equal(out.bagel, 25);
    assert.equal(out.cookie, 0, 'missing keys default to 0');
  });

  it('rejects unknown product keys', () => {
    assert.throws(
      () => validateQuantitiesPayload({ latte: 10 }),
      /quantities has unknown product "latte"/,
    );
  });

  it('rejects negative or non-integer values', () => {
    assert.throws(
      () => validateQuantitiesPayload({ croissant: -1 }),
      /quantities\.croissant must be a non-negative integer/,
    );
    assert.throws(
      () => validateQuantitiesPayload({ croissant: 1.5 }),
      /quantities\.croissant must be a non-negative integer/,
    );
  });

  it('does NOT cross-check menu — Finance can stock before Operations sets menu', () => {
    // M-17: validateQuantitiesPayload is independent of menu state. The
    // simulator naturally produces 0 customers / 0 revenue for products
    // not on the menu, so a stocked-but-disabled product just wastes the
    // cost. Stocking cookie/sandwich/matcha (locked products on a fresh
    // team) should validate cleanly here — the menu/unlock check lives
    // in submitDecision (Operations) where it belongs.
    const out = validateQuantitiesPayload({
      croissant: 100, cookie: 50, sandwich: 30, matcha: 20,
    });
    assert.equal(out.croissant, 100);
    assert.equal(out.cookie, 50);
    assert.equal(out.sandwich, 30);
    assert.equal(out.matcha, 20);
  });
});

describe('submitDecision strips quantities post-M-17', () => {
  it('validateDecision still returns quantities (used during transition for the simulator path that pre-dates M-17)', () => {
    // The validator's contract is unchanged — submitDecision is the one
    // that now deletes `validated.quantities` before persisting. This
    // test pins the validator behavior so the deletion at the call site
    // remains the only place quantities is dropped.
    const validated = validateDecision(baseInput(), 1, config, {});
    assert.ok(validated.quantities, 'validator still produces a quantities map');
    assert.equal(validated.quantities.croissant, 100);
  });

  it('simulating the M-17 strip pattern preserves Finance-written quantities under {...validated} merge', () => {
    // submitPrices writes quantities first; submitDecision then deletes
    // validated.quantities and spreads the rest. Without the delete,
    // ...validated would clobber Finance's quantities write. This test
    // pins that pattern.
    const financeQuantities = { croissant: 200, bagel: 200, coffee: 200 };
    const validated = validateDecision(baseInput(), 1, config, {});
    delete validated.quantities; // M-17 strip
    const decisionDoc = {
      round: 1,
      // Pretend Finance already wrote these via submitPrices.
      productPrices: { croissant: 4.75 },
      quantities: financeQuantities,
      pricesSubmittedAt: 'sentinel-1',
      // Now Operations spreads validated:
      ...validated,
      submittedAt: 'sentinel-2',
    };
    assert.deepEqual(decisionDoc.quantities, financeQuantities,
      'Finance quantities must survive Operations submitDecision after M-17');
  });
});
