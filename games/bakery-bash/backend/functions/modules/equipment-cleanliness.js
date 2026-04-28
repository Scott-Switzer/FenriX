/**
 * equipment-cleanliness.js — Pure helpers for the equipment grade and
 * cleanliness drift mechanics. CommonJS, no Firebase deps.
 */

const {
  EQUIPMENT_GRADES,
  EQUIPMENT_TIER_COSTS,
  EQUIPMENT_CAPACITY_FACTOR,
  EQUIPMENT_SATISFACTION_FACTOR,
  CLEANLINESS_SATISFACTION_FACTOR,
  CLEANLINESS_BANDS,
  CLEANLINESS_STAFF_BOOST_PER_HEAD,
  CLEANLINESS_DRAIN_PER_CUSTOMER,
} = require('./config');

function equipmentFactorCapacity(grade) {
  const v = EQUIPMENT_CAPACITY_FACTOR[grade];
  return Number.isFinite(v) ? v : 1.00;
}

function equipmentFactorSatisfaction(grade) {
  const v = EQUIPMENT_SATISFACTION_FACTOR[grade];
  return Number.isFinite(v) ? v : 1.00;
}

function cleanlinessFactor(grade) {
  const v = CLEANLINESS_SATISFACTION_FACTOR[grade];
  return Number.isFinite(v) ? v : 1.00;
}

function gradeFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 'F';
  if (n >= 100) return 'A';
  for (const band of CLEANLINESS_BANDS) {
    if (n >= band.min && n < band.max) return band.grade;
  }
  return 'F';
}

function cleanlinessDriftDelta(maintenanceStaff, customers) {
  const s = Number.isFinite(Number(maintenanceStaff)) ? Number(maintenanceStaff) : 0;
  const c = Number.isFinite(Number(customers)) ? Number(customers) : 0;
  return s * CLEANLINESS_STAFF_BOOST_PER_HEAD - c * CLEANLINESS_DRAIN_PER_CUSTOMER;
}

function nextEquipmentGrade(grade) {
  const idx = EQUIPMENT_GRADES.indexOf(grade);
  if (idx < 0) return null;
  if (idx === EQUIPMENT_GRADES.length - 1) return null; // already at A
  return EQUIPMENT_GRADES[idx + 1];
}

function tierUpgradeCost(currentGrade) {
  if (currentGrade === 'A') return null;
  const cost = EQUIPMENT_TIER_COSTS[currentGrade];
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

module.exports = {
  equipmentFactorCapacity,
  equipmentFactorSatisfaction,
  cleanlinessFactor,
  gradeFromScore,
  cleanlinessDriftDelta,
  nextEquipmentGrade,
  tierUpgradeCost,
};
