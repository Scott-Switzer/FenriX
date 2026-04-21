#!/usr/bin/env node
/**
 * seed-catalogs.js — BE-04
 *
 * Seeds the Firestore catalogs collection with:
 *   1. Chef catalog  — 4 nationalities × gender variants at 3 skill levels
 *   2. Menu catalog  — 6 products with prices, base costs, and descriptions
 *   3. Insight templates — pre-written market insight templates per round
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<path> node scripts/seed-catalogs.js [--project <id>]
 *
 * For the local emulator:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/seed-catalogs.js --project bakery-bash-54d12
 */

'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

// ---------------------------------------------------------------------------
// Chef catalog
// ---------------------------------------------------------------------------
// Multiplier tiers: [novel, intermediate, advanced]
// novel      = 1.0× base / 1.4× specialty
// intermediate = 1.25× base / 1.75× specialty
// advanced   = 1.6× base / 2.2× specialty

const SKILL_TIERS = [
  { level: 'novel',        baseMultiplier: 1.0,  specialtyMultiplier: 1.4 },
  { level: 'intermediate', baseMultiplier: 1.25, specialtyMultiplier: 1.75 },
  { level: 'advanced',     baseMultiplier: 1.6,  specialtyMultiplier: 2.2 },
];

/**
 * Build a set of chef entries for one nationality.
 * @param {object} opts
 * @param {string} opts.nationality  Display name, e.g. 'French'
 * @param {string} opts.flag         Emoji flag, e.g. '🇫🇷'
 * @param {string[]} opts.specialties  Product keys this nationality excels at
 * @param {string[]} opts.maleVariants   ['A','B','C'] or ['A','B']
 * @param {string[]} opts.femaleVariants
 * @returns {object[]} Array of chef catalog entries
 */
function buildChefs({ nationality, flag, specialties, maleVariants, femaleVariants }) {
  const chefs = [];
  for (const tier of SKILL_TIERS) {
    for (const variant of maleVariants) {
      chefs.push({
        chefId: `${nationality.toLowerCase()}_m_${variant.toLowerCase()}_${tier.level}`,
        nationality,
        flag,
        gender: 'male',
        variant,
        skillLevel: tier.level,
        specialties,
        baseMultiplier: tier.baseMultiplier,
        specialtyMultiplier: tier.specialtyMultiplier,
        displayName: `${flag} ${nationality} Chef (M-${variant})`,
      });
    }
    for (const variant of femaleVariants) {
      chefs.push({
        chefId: `${nationality.toLowerCase()}_f_${variant.toLowerCase()}_${tier.level}`,
        nationality,
        flag,
        gender: 'female',
        variant,
        skillLevel: tier.level,
        specialties,
        baseMultiplier: tier.baseMultiplier,
        specialtyMultiplier: tier.specialtyMultiplier,
        displayName: `${flag} ${nationality} Chef (F-${variant})`,
      });
    }
  }
  return chefs;
}

const CHEF_CATALOG = [
  ...buildChefs({
    nationality: 'French',
    flag: '🇫🇷',
    specialties: ['croissant', 'coffee'],
    maleVariants: ['A', 'B', 'C'],
    femaleVariants: ['A', 'B', 'C'],
  }),
  ...buildChefs({
    nationality: 'Japanese',
    flag: '🇯🇵',
    specialties: ['matcha', 'croissant'],
    maleVariants: ['A', 'B'],
    femaleVariants: ['A', 'B'],
  }),
  ...buildChefs({
    nationality: 'Italian',
    flag: '🇮🇹',
    specialties: ['sandwich', 'coffee'],
    maleVariants: ['A', 'B'],
    femaleVariants: ['A', 'B'],
  }),
  ...buildChefs({
    nationality: 'American',
    flag: '🇺🇸',
    specialties: ['bagel', 'cookie'],
    maleVariants: ['A', 'B', 'C'],
    femaleVariants: ['A', 'B', 'C'],
  }),
];

// ---------------------------------------------------------------------------
// Menu / product catalog
// ---------------------------------------------------------------------------
// MIG-01: latte → coffee, matchaLatte → matcha
const MENU_CATALOG = [
  {
    productKey: 'coffee',
    displayName: 'Coffee',
    emoji: '☕',
    basePrice: 4.00,
    unitCost: 0.80,
    category: 'drink',
    description: 'A classic brewed coffee — always a crowd-pleaser.',
    baseProduct: false,   // starts off-menu; player adds via menu toggle
  },
  {
    productKey: 'croissant',
    displayName: 'Croissant',
    emoji: '🥐',
    basePrice: 4.75,
    unitCost: 1.20,
    category: 'pastry',
    description: 'Buttery, flaky, layered perfection.',
    baseProduct: true,
  },
  {
    productKey: 'bagel',
    displayName: 'Bagel',
    emoji: '🥯',
    basePrice: 3.00,
    unitCost: 0.60,
    category: 'pastry',
    description: 'Hearty New York-style bagels. High volume, steady margins.',
    baseProduct: true,
  },
  {
    productKey: 'cookie',
    displayName: 'Cookie',
    emoji: '🍪',
    basePrice: 2.50,
    unitCost: 0.40,
    category: 'pastry',
    description: 'Soft-baked cookies. Low cost, impulse-buy favourite.',
    baseProduct: true,
  },
  {
    productKey: 'sandwich',
    displayName: 'Sandwich',
    emoji: '🥪',
    basePrice: 8.75,
    unitCost: 2.50,
    category: 'savoury',
    description: 'Hearty lunch sandwiches. High value but prep-intensive.',
    baseProduct: false,
  },
  {
    productKey: 'matcha',
    displayName: 'Matcha Latte',
    emoji: '🍵',
    basePrice: 6.25,
    unitCost: 1.50,
    category: 'drink',
    description: 'Trendy ceremonial-grade matcha. Premium positioning.',
    baseProduct: false,
  },
];

// ---------------------------------------------------------------------------
// Insight templates (used as fallbacks or for seeding the preferences collection)
// ---------------------------------------------------------------------------
const INSIGHT_TEMPLATES = [
  {
    round: 1,
    subject: 'The Plaza Times — Round 1 Market Briefing',
    body: `Good morning, bakery owners! It's a clear spring day and foot traffic is expected to be steady.
Customers are in the mood for familiar favourites this round. Croissants and bagels are trending,
while specialty drinks are generating curiosity. Keep an eye on your quantities — early rounds
reward conservative, balanced menus.`,
    from: 'The Plaza Times',
  },
  {
    round: 2,
    subject: 'The Plaza Times — Round 2 Market Briefing',
    body: `Temperatures are rising and so is competition. Early adopters of specialty coffees are
reporting strong satisfaction scores. Sandwich demand is ticking up among the lunch crowd.
Customers with high satisfaction from Round 1 are returning — make sure your top products
are well stocked.`,
    from: 'The Plaza Times',
  },
  {
    round: 3,
    subject: 'The Plaza Times — Round 3 Market Briefing',
    body: `Midpoint! The market is maturing and customers are becoming more discerning. Bakeries
that have built returning customer bases are pulling ahead. Premium drinks (matcha, coffee)
are seeing a surge — consider unlocking them if you haven't. Chef specialisation is now
making a measurable revenue difference.`,
    from: 'The Plaza Times',
  },
  {
    round: 4,
    subject: 'The Plaza Times — Round 4 Market Briefing',
    body: `The stretch run begins. Competition for advertising slots is fierce, and the top-bid
values are climbing. Your returning customer pool is a key differentiator now — protect
satisfaction scores. Sous chef headcount is becoming a bottleneck for high-volume operations.`,
    from: 'The Plaza Times',
  },
  {
    round: 5,
    subject: 'The Plaza Times — Round 5 Market Briefing',
    body: `Final round! Everything is on the line. The customer pool is largest it has ever been,
rewarding bakeries with the strongest satisfaction histories. Ad spend ROI peaks today — the
winning ad slot can swing the outcome. Trust your model, execute your plan, and finish strong.`,
    from: 'The Plaza Times',
  },
];

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------
const BATCH_LIMIT = 480;

async function seedCollection(collectionPath, docs, idField) {
  console.log(`\nSeeding ${collectionPath} (${docs.length} docs)…`);
  let batch = db.batch();
  let count = 0;

  for (const doc of docs) {
    const ref = db.collection(collectionPath).doc(doc[idField]);
    batch.set(ref, { ...doc, seededAt: FieldValue.serverTimestamp() }, { merge: true });
    count++;
    if (count % BATCH_LIMIT === 0) {
      await batch.commit();
      console.log(`  committed ${count}…`);
      batch = db.batch();
    }
  }

  if (count % BATCH_LIMIT !== 0) {
    await batch.commit();
  }
  console.log(`  ✓ ${docs.length} documents written to ${collectionPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Bakery Bash catalog seed (BE-04) ===\n');

  await seedCollection('catalog/chefs/items', CHEF_CATALOG, 'chefId');
  await seedCollection('catalog/menu/items', MENU_CATALOG, 'productKey');

  // Insight templates go to catalog/insights/rounds/{round}
  console.log('\nSeeding catalog/insights/rounds…');
  let batch = db.batch();
  for (const t of INSIGHT_TEMPLATES) {
    const ref = db.collection('catalog/insights/rounds').doc(String(t.round));
    batch.set(ref, { ...t, seededAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await batch.commit();
  console.log(`  ✓ ${INSIGHT_TEMPLATES.length} insight templates written`);

  console.log('\n=== Seed complete ===');
  console.log(`Chefs:    ${CHEF_CATALOG.length}`);
  console.log(`Products: ${MENU_CATALOG.length}`);
  console.log(`Insight templates: ${INSIGHT_TEMPLATES.length}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
