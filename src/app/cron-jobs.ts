import { drainOutbox, sweepOutbox } from '@/modules/notifications/outbox'; // notifications
import { recheckSsoDomains, sweepSsoStates } from '@/modules/sso/hooks'; // sso
import { cronWebhooks } from '@/modules/apikeys/webhooks'; // apikeys
import { sendRemindersEverywhere } from '@/lib/knotwork/guests/public';
import { purgePhotosEverywhere } from '@/lib/knotwork/photos/public';

// Clone-owned (plan §3.2): /api/cron calls this after its own core sweeps. A clone adds its jobs here,
// and removing the notifications module deletes the lines marked `// notifications`.
export async function cronJobs(): Promise<Record<string, unknown>> {
  const jobs: Record<string, unknown> = {};
  // Knotwork (Phase 5): due RSVP reminders where the couple turned the schedule on. First, so the drain below sends
  // them in the same run. Idempotent with the button: each step is recorded once per household (ChaseEvent).
  jobs.rsvpReminders = await sendRemindersEverywhere();
  jobs.outbox = { ...(await drainOutbox()), swept: await sweepOutbox() }; // notifications
  jobs.ssoStates = await sweepSsoStates(); // sso
  jobs.ssoDomains = await recheckSsoDomains(); // sso
  jobs.webhooks = await cronWebhooks(); // apikeys
  // Knotwork: the photo retention purge (PRD P0-6). The day is derived from each wedding's date (rule 1).
  jobs.photoRetention = await purgePhotosEverywhere();
  return jobs;
}
