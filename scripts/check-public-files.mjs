import { execFileSync } from 'node:child_process';

const mode = process.argv[2] || '--tracked';
let guardSkipped = false;

const blockedRules = [
  [/^AGENTS\.md$/i, 'local agent instructions'],
  [/^PRODUCTION_CHECKLIST\.md$/i, 'internal production checklist'],
  [/^\.factory\//i, 'local QA agent factory assets'],
  [/^\.server-dist\//i, 'generated server build output'],
  [/^droid-wiki\//i, 'generated/internal wiki export'],
  [/^docs\/.*(todo|competitor).*\.md$/i, 'internal planning or competitor notes'],
  [/^qa-.*\.(png|jpe?g|json|md)$/i, 'local QA evidence'],
  [/^qa-results\//i, 'local QA evidence'],
  [/(^|\/)[^/]*\.log(\..*)?$/i, 'local log output'],
  [/(^|\/)[^/]*\.(db|sqlite)([-.].*)?$/i, 'local database file'],
  [/^dump\.sql$/i, 'local database dump'],
  [/^-w$/i, 'stray generated build file'],
  [/^test-api\.(js|mjs)$/i, 'scratch API probe'],
  [/^test-regex\.js$/i, 'scratch regex probe'],
  [/^test-scraper\.ts$/i, 'scratch scraper probe'],
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function hasGitWorktree() {
  try {
    return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

function normalize(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function filesForMode() {
  if (mode === '--staged') {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT'])
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalize);
  }

  if (mode === '--tracked') {
    if (!hasGitWorktree()) {
      console.log('Public file guard skipped: no Git worktree metadata is available.');
      guardSkipped = true;
      return [];
    }

    return git(['ls-files'])
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalize);
  }

  console.error(`Unknown mode: ${mode}`);
  process.exit(2);
}

const violations = [];

for (const file of filesForMode()) {
  const match = blockedRules.find(([pattern]) => pattern.test(file));
  if (match) {
    violations.push({ file, reason: match[1] });
  }
}

if (violations.length > 0) {
  console.error('Blocked files are tracked or staged for commit:');
  for (const { file, reason } of violations) {
    console.error(`- ${file} (${reason})`);
  }
  console.error('');
  console.error('Keep these files local. If already tracked, remove them with git rm --cached.');
  process.exit(1);
}

if (!guardSkipped) {
  console.log('Public file guard passed.');
}
