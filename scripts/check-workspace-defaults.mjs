import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const registrationTier = read('server/services/registrationTier.ts');
assert(
  /return ['"]enterprise['"]/.test(registrationTier),
  'New registrations must receive the full workspace default tier',
);

const authRoutes = read('server/routes/auth.ts');
assert(
  authRoutes.includes("tier: (user.tier as 'free' | 'pro' | 'enterprise') || 'enterprise'"),
  'Profiles with no stored tier must normalize to the full workspace default tier',
);

const dataImportStatusPanel = read('src/components/app/DataImportStatusPanel.tsx');
assert(
  !dataImportStatusPanel.includes('autoImportKeys'),
  'Date-range readiness UI must not silently auto-queue missing history imports',
);
assert(
  !dataImportStatusPanel.includes('Failed to start automatic import'),
  'Missing range imports should be lifecycle-driven, not triggered by the visible report panel',
);

const manualImportCount = (dataImportStatusPanel.match(/queueMissingCoverageSync\(/g) || []).length;
assert(
  manualImportCount === 1,
  'The source-data panel may keep one explicit manual import action, but no hidden auto-import effect',
);

const accountRoutes = read('server/routes/accountData.ts');
assert(
  accountRoutes.includes('void queueKnownSiteDataIfPossible(user.id, uniqueSites(['),
  'Connected profile loads must prime full-history imports for saved workspace sites',
);
assert(
  accountRoutes.includes('user.activatedSiteUrl ||')
    && accountRoutes.includes('...user.unlockedSites')
    && accountRoutes.includes('...user.knownSites'),
  'Profile priming must include the active, unlocked, and known workspace sites',
);
console.log('Workspace defaults check passed');
