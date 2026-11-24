// Shared by the Knotwork tests: the JSON fixtures in fixtures/, read once.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MovePreview, PlanTask, Schedule } from '@/lib/knotwork/schedule/engine';

export const ROOT = resolve(__dirname, '../..');
export const readJson = <T>(rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as T;

export type ScheduleFixture = {
  name: string;
  note: string;
  weddingDate: string;
  today: string;
  tasks: PlanTask[];
  expect: Schedule;
  move?: { to: string; expect: MovePreview };
};

const DIR = 'fixtures/schedule';
export const scheduleFixtures: ScheduleFixture[] = readdirSync(join(ROOT, DIR))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => readJson<ScheduleFixture>(`${DIR}/${f}`));
export const scheduleFixture = (name: string) => {
  const f = scheduleFixtures.find((x) => x.name === name);
  if (!f) throw new Error(`no schedule fixture ${name}`);
  return f;
};
