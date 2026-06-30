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

console.log('Workspace defaults check passed');
