/**
 * Stamps the site with where it came from: commit, branch, build time, engine
 * version and test count. Written to site/data/build.json and shown in the
 * footer, so a deployed page can always be traced back to a commit.
 *
 * On Vercel the commit comes from the environment; locally from git.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function git(args, fallback = null) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const env = process.env;

const commit = env.VERCEL_GIT_COMMIT_SHA || git('rev-parse HEAD') || 'unknown';
const branch = env.VERCEL_GIT_COMMIT_REF || git('rev-parse --abbrev-ref HEAD') || 'unknown';
const commitDate = git('log -1 --format=%cI') || new Date().toISOString();
const commitCount = Number(git('rev-list --count HEAD') || 0);

/* Count test cases the same way the runner does: one `test(` per case. */
let tests = 0;
try {
  const { readdirSync } = await import('node:fs');
  for (const file of readdirSync(resolve('engine/test'))) {
    if (!file.endsWith('.test.ts')) continue;
    tests += (readFileSync(resolve('engine/test', file), 'utf8').match(/^test\(/gm) || []).length;
  }
} catch {
  tests = 0;
}

const info = {
  version: pkg.version,
  commit,
  short: commit.slice(0, 7),
  branch,
  commitCount,
  commitDate,
  builtAt: new Date().toISOString(),
  tests,
  host: env.VERCEL ? 'vercel' : 'local',
};

mkdirSync(resolve('site/data'), { recursive: true });
writeFileSync(resolve('site/data/build.json'), `${JSON.stringify(info, null, 2)}\n`);
process.stdout.write(`  build ${info.short} on ${info.branch} · v${info.version} · ${info.tests} tests\n`);
