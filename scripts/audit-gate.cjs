#!/usr/bin/env node
/*
 * Dependency audit gate (INF-6). Fails the pipeline when a production
 * dependency has a high or critical advisory that is not allowlisted.
 *
 * Works with npm (package-lock.json) and pnpm (pnpm-lock.yaml). An advisory
 * that cannot be fixed yet goes in audit-allowlist.json next to package.json,
 * with why and until when:
 *
 *   [{ "id": "GHSA-xxxx-xxxx-xxxx", "package": "name",
 *      "reason": "why it does not apply / what fixes it", "until": "2026-12-31" }]
 *
 * An entry past its `until` date stops counting, so nothing stays ignored by
 * accident. Usage: node scripts/audit-gate.cjs
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const usesPnpm = fs.existsSync(path.join(root, 'pnpm-lock.yaml'));
const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
  const [cmd, args] = usesPnpm
    ? ['pnpm', ['audit', '--prod', '--json']]
    : ['npm', ['audit', '--omit=dev', '--json']];
  try {
    return execFileSync(cmd, args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // Both exit non-zero when they find anything; the JSON is still on stdout.
    if (error.stdout) return error.stdout;
    throw error;
  }
}

/** Every advisory as { id, package, severity, title, url }. */
function advisories(report) {
  const found = new Map();
  if (report.advisories) {
    // pnpm
    for (const a of Object.values(report.advisories)) {
      const id = a.github_advisory_id || String(a.id);
      found.set(`${id}:${a.module_name}`, {
        id,
        package: a.module_name,
        severity: a.severity,
        title: a.title,
        url: a.url,
      });
    }
  } else {
    // npm v7+: the advisory objects sit in each vulnerable package's `via`
    for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
      for (const via of v.via || []) {
        if (typeof via !== 'object') continue;
        const id = (via.url || '').split('/').pop() || String(via.source);
        found.set(`${id}:${via.name || name}`, {
          id,
          package: via.name || name,
          severity: via.severity,
          title: via.title,
          url: via.url,
        });
      }
    }
  }
  return [...found.values()];
}

function loadAllowlist() {
  const file = path.join(root, 'audit-allowlist.json');
  if (!fs.existsSync(file)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of entries) {
    if (e.until && e.until < today) {
      console.log(`audit-allowlist: ${e.id} (${e.package}) expired on ${e.until}; it counts again.`);
    }
  }
  return entries.filter((e) => !e.until || e.until >= today);
}

const report = JSON.parse(runAudit());
const allowed = loadAllowlist();
const isAllowed = (a) =>
  allowed.some((e) => e.id === a.id && (!e.package || e.package === a.package));

const blocking = advisories(report).filter(
  (a) => BLOCKING.has(a.severity) && !isAllowed(a),
);
const waived = advisories(report).filter(
  (a) => BLOCKING.has(a.severity) && isAllowed(a),
);

for (const a of waived) {
  console.log(`allowed  ${a.severity.padEnd(8)} ${a.package}: ${a.title} (${a.id})`);
}
if (blocking.length) {
  console.error(`\n${blocking.length} high or critical advisories in production dependencies:\n`);
  for (const a of blocking) {
    console.error(`  ${a.severity.padEnd(8)} ${a.package}: ${a.title}\n           ${a.url || a.id}`);
  }
  console.error(
    '\nUpdate the dependency (npm audit fix / pnpm update), or, if no fix exists yet, add it to audit-allowlist.json with a reason and an until date.',
  );
  process.exit(1);
}
console.log(`audit gate: no blocking advisories (${waived.length} allowlisted).`);
