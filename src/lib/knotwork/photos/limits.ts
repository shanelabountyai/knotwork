// Photo upload limits as data (PRD P0-6: "per-device rate limits"). PURE. The numbers live in rules/photo-limits.json;
// this file gives them a shape, names the counters, and replays a list of uploads the way the store applies them, so
// the fixtures (fixtures/photos/limits) and the Python oracle (tools/photo_limits.py) can be checked against it.
//
// The store counts with src/core/rate-limit.ts `hit`: a fixed window, one counter per (key, window), and EVERY hit
// counts, a refused one too. For each upload the counters are hit in order (device, address, event) and the first
// refusal ends it: later counters are not touched. A blocked device is refused before any counter.
import rules from '../../../../rules/photo-limits.json';

export type Window = { limit: number; windowMinutes: number };
export type UploadLimits = { perDevice: Window; perAddress: Window; perEvent: Window };
export const PHOTO_LIMITS: { upload: UploadLimits; pagePerAddress: Window; maxPhotosPerEvent: number } = { upload: rules.upload, pagePerAddress: rules.pagePerAddress, maxPhotosPerEvent: rules.maxPhotosPerEvent };

/** A window in the shape `hit` takes. */
export const asLimit = (w: Window) => ({ limit: w.limit, windowMs: w.windowMinutes * 60_000 });

export const LIMIT_ORDER = ['device', 'address', 'event'] as const;
export type LimitName = (typeof LIMIT_ORDER)[number];
export type Outcome = 'ok' | 'blocked' | LimitName;

/** The counter keys for one upload, in the order they are hit. */
export const limitKeys = (eventId: string, deviceHash: string, address: string): Record<LimitName, string> => ({
  device: `photo:device:${eventId}:${deviceHash}`,
  address: `photo:address:${eventId}:${address}`,
  event: `photo:event:${eventId}`,
});

export type Attempt = { t: number; device: string; address: string };
/** A compact way to write many attempts: `count` uploads from `from` seconds, `every` seconds apart, the devices taking turns. */
export type Burst = { from: number; every: number; count: number; devices: string[]; address: string };

export function expand(steps: (Attempt | Burst)[]): Attempt[] {
  const out = steps.flatMap((s) => ('count' in s ? Array.from({ length: s.count }, (_, i) => ({ t: s.from + i * s.every, device: s.devices[i % s.devices.length]!, address: s.address })) : [s]));
  return out.map((a, i) => ({ a, i })).sort((x, y) => x.a.t - y.a.t || x.i - y.i).map((x) => x.a);
}

/** Replays attempts (seconds from zero, in time order) against the limits. One outcome per attempt. */
export function simulate(limits: UploadLimits, attempts: Attempt[], blocked: readonly string[] = []): Outcome[] {
  const counts = new Map<string, number>();
  const windows: Record<LimitName, Window> = { device: limits.perDevice, address: limits.perAddress, event: limits.perEvent };
  const hit = (name: LimitName, id: string, t: number) => {
    const w = windows[name];
    const key = `${name}:${id}:${Math.floor(t / (w.windowMinutes * 60))}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= w.limit;
  };
  return attempts.map((a) => {
    if (blocked.includes(a.device)) return 'blocked';
    if (!hit('device', a.device, a.t)) return 'device';
    if (!hit('address', a.address, a.t)) return 'address';
    if (!hit('event', '', a.t)) return 'event';
    return 'ok';
  });
}

/** Outcomes as runs, for a fixture a person can read: [['ok', 30], ['device', 5]]. */
export function runs(outcomes: Outcome[]): [Outcome, number][] {
  const out: [Outcome, number][] = [];
  for (const o of outcomes) {
    const last = out[out.length - 1];
    if (last && last[0] === o) last[1]++;
    else out.push([o, 1]);
  }
  return out;
}
