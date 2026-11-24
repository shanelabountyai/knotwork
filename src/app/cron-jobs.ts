import { drainOutbox, sweepOutbox } from '@/modules/notifications/outbox'; // notifications
import { recheckSsoDomains, sweepSsoStates } from '@/modules/sso/hooks'; // sso
import { cronWebhooks } from '@/modules/apikeys/webhooks'; // apikeys
import { purgePhotosEverywhere } from '@/lib/knotwork/photos/public';

// Clone-owned (plan §3.2): /api/cron calls this after its own core sweeps. A clone adds its jobs here,
// and removing the notifications module deletes the lines marked `// notifications`.
export async function cronJobs(): Promise<Record<string, unknown>> {
  const jobs: Record<string, unknown> = {};
  jobs.outbox = { ...(await drainOutbox()), swept: await sweepOutbox() }; // notifications
  jobs.ssoStates = await sweepSsoStates(); // sso
  jobs.ssoDomains = await recheckSsoDomains(); // sso
  jobs.webhooks = await cronWebhooks(); // apikeys
  // Knotwork: the photo retention purge (PRD P0-6). The day is derived from each wedding's date (rule 1).
  jobs.photoRetention = await purgePhotosEverywhere();
  return jobs;
}
