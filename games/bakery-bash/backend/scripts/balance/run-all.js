#!/usr/bin/env node
/**
 * run-all.js — One-button verification suite. Runs every test in the
 * `scripts/balance/` directory plus the existing E2E tests through the
 * emulator (if available), aggregates results, and reports.
 *
 * Run:  node scripts/balance/run-all.js
 *
 * Exit code 0 if all tests pass, 1 if any fail.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Color helpers (only when stdout is TTY)
const isTTY = process.stdout.isTTY;
const c = {
  green: (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red: (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  bold: (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  dim: (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
};

const tests = [
  { name: 'Math correctness',                    cmd: 'node', args: ['scripts/balance/math-verify.js'], needsEmulator: false },
  { name: 'Fuzz / invariants (10k iterations)',  cmd: 'node', args: ['scripts/balance/fuzz.js', '10000'], needsEmulator: false },
  { name: 'Edge cases',                          cmd: 'node', args: ['scripts/balance/edge-cases.js'], needsEmulator: false },
  { name: 'Determinism + curveball',             cmd: 'node', args: ['scripts/balance/determinism-curveball.js'], needsEmulator: false },
  { name: 'Exploit hunt',                        cmd: 'node', args: ['scripts/balance/exploit-hunt.js'], needsEmulator: false },
  { name: 'Tournament (round-robin)',            cmd: 'node', args: ['scripts/balance/run-tournament.js'], env: { BAL_REPS: '20' }, needsEmulator: false },
  { name: 'Multi-team scaling',                  cmd: 'node', args: ['scripts/balance/scaling-test.js'], needsEmulator: false },
  { name: 'Sensitivity sweeps',                  cmd: 'node', args: ['scripts/balance/sensitivity.js'], needsEmulator: false },
  { name: 'Adversarial best-response',           cmd: 'node', args: ['scripts/balance/adversarial.js'], needsEmulator: false, slow: true },
  { name: 'Ad bonus gate (production)',          cmd: 'node', args: ['scripts/test-ad-bonus-gate.js'], needsEmulator: false },
  // Emulator-required tests:
  { name: 'E2E: multi-team-costs',               cmd: 'node', args: ['scripts/test-multi-team-costs.js'], needsEmulator: true },
  { name: 'E2E: chef-cap-enforcement',           cmd: 'node', args: ['scripts/test-chef-cap-enforcement.js'], needsEmulator: true },
  { name: 'E2E: phase-flow',                     cmd: 'node', args: ['scripts/test-phase-flow.js'], needsEmulator: true },
  { name: 'E2E: balance/firestore-verify',       cmd: 'node', args: ['scripts/balance/e2e-firestore-verify.js'], needsEmulator: true },
  { name: 'E2E: apr23 multi-team multi-role',    cmd: 'node', args: ['scripts/test-apr23-e2e.js'], needsEmulator: true },
];

const skipFlags = new Set(process.argv.slice(2));
const skipSlow = skipFlags.has('--no-slow');
const skipEmulator = skipFlags.has('--no-emulator');

// Detect if emulator is running
function emulatorRunning() {
  // Test if firestore emulator port is listening
  const r = spawnSync('lsof', ['-i', ':8080'], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) return false;
  const out = r.stdout || '';
  return /java|node/.test(out);
}

const haveEmulator = emulatorRunning();
if (!haveEmulator && !skipEmulator) {
  console.log(c.yellow('⚠ Emulator not detected on :8080. E2E tests will be skipped.'));
  console.log(c.dim('  Run `firebase emulators:start` separately to enable them.\n'));
}

const env = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  GCLOUD_PROJECT: 'bakery-bash-54d12',
};

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const results = [];

for (const t of tests) {
  if (t.slow && skipSlow) {
    console.log(c.dim(`SKIP (slow):    ${t.name}`));
    results.push({ name: t.name, status: 'skip', reason: 'slow' });
    totalSkipped++;
    continue;
  }
  if (t.needsEmulator && (!haveEmulator || skipEmulator)) {
    console.log(c.dim(`SKIP (no emul): ${t.name}`));
    results.push({ name: t.name, status: 'skip', reason: 'no emulator' });
    totalSkipped++;
    continue;
  }

  const t0 = Date.now();
  process.stdout.write(`Running: ${t.name}... `);
  const testEnv = t.env ? { ...env, ...t.env } : env;
  const result = spawnSync(t.cmd, t.args, {
    cwd: ROOT,
    env: testEnv,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 600 * 1000, // 10 min max per test
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (result.status === 0) {
    console.log(c.green(`PASS`) + ` ${c.dim('(' + dt + 's)')}`);
    totalPassed++;
    results.push({ name: t.name, status: 'pass', dt, output: result.stdout });
  } else {
    console.log(c.red(`FAIL`) + ` ${c.dim('(' + dt + 's)')}`);
    totalFailed++;
    results.push({ name: t.name, status: 'fail', dt, output: result.stdout, stderr: result.stderr });
  }
}

console.log('\n' + '='.repeat(70));
console.log(c.bold('Summary'));
console.log('='.repeat(70));
console.log(c.green(`  ${totalPassed} passed`) + `, ` + c.red(`${totalFailed} failed`) + `, ${c.dim(totalSkipped + ' skipped')}`);

if (totalFailed > 0) {
  console.log('\n' + c.bold('Failures:'));
  for (const r of results.filter((x) => x.status === 'fail')) {
    console.log('\n' + c.red('FAIL: ' + r.name));
    if (r.output) {
      const lines = r.output.split('\n');
      // Show last 20 lines of output
      const tail = lines.slice(-20).join('\n');
      console.log(c.dim('---stdout (last 20 lines)---'));
      console.log(tail);
    }
    if (r.stderr) {
      console.log(c.dim('---stderr---'));
      console.log(r.stderr);
    }
  }
  process.exit(1);
}

// On success, also extract key metrics
console.log('\n' + c.bold('Key metrics from passes:'));
for (const r of results.filter((x) => x.status === 'pass')) {
  if (!r.output) continue;
  const lines = r.output.split('\n');
  // Find lines like "X passed, Y failed" or "RESULTS: X passed"
  for (const line of lines) {
    if (/passed.*failed|RESULTS:|invariant.*passed|All.*passed|All.*invariants|All math|all edge|all 24|EDGE CASE RESULTS/.test(line)) {
      console.log(c.dim('  [' + r.name + ']') + ' ' + line.trim());
      break;
    }
  }
}

console.log('\n' + c.green(c.bold('✓ ALL VERIFICATION PASSES')));
process.exit(0);
