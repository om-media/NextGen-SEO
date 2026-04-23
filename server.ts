import multer from 'multer';
import { buildApp, type SyncJobState } from './server/app.js';
import { initializeDatabase } from './server/database.js';
import { attachFrontend } from './server/frontend.js';

const upload = multer({ dest: 'uploads/' });
const syncJobs = new Map<string, SyncJobState>();
const getSyncJobKey = (ownerId: string, siteUrl: string) => `${ownerId}:${siteUrl}`;
const db = initializeDatabase();

async function startServer() {
  const PORT = 3000;
  const app = buildApp({ db, upload, syncJobs, getSyncJobKey });
  await attachFrontend(app);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
