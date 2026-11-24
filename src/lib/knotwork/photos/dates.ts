// The two days a photo event has, both DERIVED from the wedding date (rule 1; D-68): no column holds either. PURE.
// Move the wedding and both move with it.
import { addDays, diffDays, type Day } from '../days';

/** The last day the upload link works: `uploadDays` after the wedding. */
export const lastUploadDay = (weddingDate: Day, uploadDays: number): Day => addDays(weddingDate, uploadDays);

/** Is the upload link working today? From the day the event is made until the last upload day, while uploads are open. */
export const linkOpen = (event: { uploadsOpen: boolean; uploadDays: number }, weddingDate: Day, today: Day): boolean =>
  event.uploadsOpen && diffDays(today, lastUploadDay(weddingDate, event.uploadDays)) <= 0;

/** The last day the photos are kept: `retentionDays` after the wedding. They are purged from the day after. */
export const lastKeptDay = (weddingDate: Day, retentionDays: number): Day => addDays(weddingDate, retentionDays);
export const purgeDue = (event: { retentionDays: number }, weddingDate: Day, today: Day): boolean => diffDays(today, lastKeptDay(weddingDate, event.retentionDays)) > 0;

export const EVENT_DEFAULTS = { uploadDays: 7, retentionDays: 365 } as const;
export const EVENT_BOUNDS = { uploadDays: { min: 0, max: 365 }, retentionDays: { min: 1, max: 3650 } } as const;
