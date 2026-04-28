const assert = require('node:assert/strict');
const {
  equipmentFactorCapacity,
  equipmentFactorSatisfaction,
  cleanlinessFactor,
  gradeFromScore,
  cleanlinessDriftDelta,
  nextEquipmentGrade,
  tierUpgradeCost,
} = require('../functions/modules/equipment-cleanliness');

describe('equipment-cleanliness helpers', () => {
  describe('equipmentFactorCapacity', () => {
    it('returns the table value per grade', () => {
      assert.equal(equipmentFactorCapacity('F'), 0.90);
      assert.equal(equipmentFactorCapacity('C'), 1.00);
      assert.equal(equipmentFactorCapacity('A'), 1.07);
    });
    it('falls back to 1.00 for unknown grades', () => {
      assert.equal(equipmentFactorCapacity('Z'), 1.00);
      assert.equal(equipmentFactorCapacity(undefined), 1.00);
    });
  });

  describe('equipmentFactorSatisfaction', () => {
    it('returns the table value per grade', () => {
      assert.equal(equipmentFactorSatisfaction('F'), 0.95);
      assert.equal(equipmentFactorSatisfaction('C'), 1.00);
      assert.equal(equipmentFactorSatisfaction('A'), 1.05);
    });
  });

  describe('cleanlinessFactor', () => {
    it('returns the table value per grade', () => {
      assert.equal(cleanlinessFactor('F'), 0.90);
      assert.equal(cleanlinessFactor('C'), 1.00);
      assert.equal(cleanlinessFactor('A'), 1.07);
    });
  });

  describe('gradeFromScore', () => {
    it('maps band edges correctly', () => {
      assert.equal(gradeFromScore(0),  'F');
      assert.equal(gradeFromScore(16), 'F');
      assert.equal(gradeFromScore(17), 'E');
      assert.equal(gradeFromScore(50), 'D');
      assert.equal(gradeFromScore(60), 'C');
      assert.equal(gradeFromScore(75), 'B');
      assert.equal(gradeFromScore(85), 'A');
      assert.equal(gradeFromScore(100), 'A');
    });
    it('clamps out-of-range scores', () => {
      assert.equal(gradeFromScore(-5),  'F');
      assert.equal(gradeFromScore(150), 'A');
    });
  });

  describe('cleanlinessDriftDelta', () => {
    it('produces -40/0/+40 at 200 customers, 0/2/4 staff', () => {
      assert.equal(cleanlinessDriftDelta(0, 200), -40);
      assert.equal(cleanlinessDriftDelta(2, 200), 0);
      assert.equal(cleanlinessDriftDelta(4, 200), 40);
    });
    it('clamps non-numeric inputs to 0', () => {
      assert.equal(cleanlinessDriftDelta(NaN, 200), -40);
      assert.equal(cleanlinessDriftDelta(2, NaN), 40);
    });
  });

  describe('nextEquipmentGrade', () => {
    it('returns next-up grade', () => {
      assert.equal(nextEquipmentGrade('F'), 'E');
      assert.equal(nextEquipmentGrade('C'), 'B');
      assert.equal(nextEquipmentGrade('B'), 'A');
    });
    it('returns null at A (no further upgrade)', () => {
      assert.equal(nextEquipmentGrade('A'), null);
    });
    it('returns null for unknown grades', () => {
      assert.equal(nextEquipmentGrade('Z'), null);
    });
  });

  describe('tierUpgradeCost', () => {
    it('returns cost from each upgradable grade', () => {
      assert.equal(tierUpgradeCost('F'), 400);
      assert.equal(tierUpgradeCost('E'), 600);
      assert.equal(tierUpgradeCost('D'), 800);
      assert.equal(tierUpgradeCost('C'), 1000);
      assert.equal(tierUpgradeCost('B'), 1200);
    });
    it('returns null at A (no upgrade available)', () => {
      assert.equal(tierUpgradeCost('A'), null);
    });
  });
});
