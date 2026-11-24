// Guest import from pasted CSV (PRD P0-3: "validated CSV"). PURE.
// Rule 4 applies to pasted text as much as to a file: cap it, validate every field, refuse anything odd, and import
// all of it or none of it. One row per guest; rows with the same household name make one household.

export const MAX_CHARS = 200_000;
export const MAX_ROWS = 2000;
export const MAX_FIELD = 200;
const COLUMNS = ['household', 'name', 'email', 'phone', 'list', 'priority', 'age_group', 'partner_status', 'wedding_party', 'address1', 'city', 'region', 'postal'] as const;
type Column = (typeof COLUMNS)[number];

export type ImportGuest = { name: string; ageGroup: 'adult' | 'child' | 'infant'; partnerStatus: 'none' | 'dating' | 'long_distance' | 'engaged' | 'married'; inWeddingParty: boolean };
export type ImportHousehold = { name: string; list: 'A' | 'B'; priority: number; email: string; phone: string; address1: string; city: string; region: string; postal: string; guests: ImportGuest[] };
export type ImportResult = { households: ImportHousehold[]; errors: { line: number; message: string }[] };

/** RFC 4180 records with the line each one starts on. An unclosed quote is an error on its starting line. */
function records(text: string): { rows: { line: number; fields: string[] }[]; error?: { line: number; message: string } } {
  const rows: { line: number; fields: string[] }[] = [];
  let [field, fields, quoted, line, start, any] = ['', [] as string[], false, 1, 1, false];
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') [field, i] = [field + '"', i + 1];
      else if (c === '"') quoted = false;
      else field += c;
      if (c === '\n') line++;
      continue;
    }
    if (c === '"' && field === '') [quoted, any] = [true, true];
    else if (c === ',') [fields, field, any] = [[...fields, field], '', true];
    else if (c === '\n') {
      if (any || field !== '') rows.push({ line: start, fields: [...fields, field] });
      [field, fields, any, line] = ['', [], false, line + 1];
      start = line;
    } else [field, any] = [field + c, true];
  }
  if (quoted) return { rows, error: { line: start, message: `Line ${start}: a quoted field is never closed.` } };
  if (any || field !== '') rows.push({ line: start, fields: [...fields, field] });
  return { rows };
}

export function parseGuestCsv(text: string): ImportResult {
  const fail = (line: number, message: string): ImportResult => ({ households: [], errors: [{ line, message }] });
  if (text.length > MAX_CHARS) return fail(0, 'That text is too large (200,000 characters at most).');
  const { rows, error } = records(text);
  if (error) return fail(error.line, error.message);
  const [head, ...data] = rows;
  const header = (head?.fields ?? []).map((h) => h.trim().toLowerCase());
  if (!header.includes('household') || !header.includes('name')) return fail(1, 'Line 1: the first line must name the columns, and include household and name.');
  const unknown = header.find((h) => !(COLUMNS as readonly string[]).includes(h));
  if (unknown) return fail(1, `Line 1: unknown column ${unknown}.`);
  if (data.length > MAX_ROWS) return fail(0, `Import at most ${MAX_ROWS} rows at a time.`);
  if (!data.length) return fail(0, 'There are no guests in that text.');

  const errors: { line: number; message: string }[] = [];
  const err = (line: number, m: string) => errors.push({ line, message: `Line ${line}: ${m}` });
  const byName = new Map<string, { h: ImportHousehold; line: number; listLine: number | null; guestLines: Map<string, number> }>();
  for (const { line, fields } of data) {
    if (fields.length !== header.length) {
      err(line, `expected ${header.length} fields, found ${fields.length}.`);
      continue;
    }
    const v = Object.fromEntries(header.map((h, i) => [h, fields[i]!.trim()])) as Partial<Record<Column, string>>;
    const before = errors.length;
    for (const c of header as Column[]) {
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v[c]!)) err(line, `${c} has a character that cannot be stored.`);
      else if (v[c]!.length > MAX_FIELD) err(line, `${c} is longer than ${MAX_FIELD} characters.`);
    }
    if (!v.household) err(line, 'household is required.');
    if (!v.name) err(line, 'name is required.');
    if (v.list && v.list !== 'A' && v.list !== 'B') err(line, 'list must be A or B.');
    if (v.age_group && !['adult', 'child', 'infant'].includes(v.age_group)) err(line, 'age_group must be adult, child or infant.');
    if (v.partner_status && !['none', 'dating', 'long_distance', 'engaged', 'married'].includes(v.partner_status)) err(line, 'partner_status must be none, dating, long_distance, engaged or married.');
    if (v.wedding_party && !['yes', 'no'].includes(v.wedding_party.toLowerCase())) err(line, 'wedding_party must be yes or no.');
    if (v.priority && !/^\d{1,4}$/.test(v.priority)) err(line, 'priority must be a whole number from 0 to 9999.');
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) err(line, 'email does not look like an address.');
    if (errors.length > before) continue;

    let entry = byName.get(v.household!);
    if (!entry) {
      entry = { h: { name: v.household!, list: 'A', priority: 100, email: '', phone: '', address1: '', city: '', region: '', postal: '', guests: [] }, line, listLine: null, guestLines: new Map() };
      byName.set(v.household!, entry);
    }
    const h = entry.h;
    if (v.list) {
      if (entry.listLine !== null && h.list !== v.list) err(line, `${h.name} is on list ${h.list} on line ${entry.listLine} and list ${v.list} here.`);
      else [h.list, entry.listLine] = [v.list as 'A' | 'B', entry.listLine ?? line];
    }
    if (v.priority && h.priority === 100) h.priority = Number(v.priority);
    for (const [col, key] of [['email', 'email'], ['phone', 'phone'], ['address1', 'address1'], ['city', 'city'], ['region', 'region'], ['postal', 'postal']] as const) if (v[col] && !h[key]) h[key] = v[col]!;
    const seen = entry.guestLines.get(v.name!.toLowerCase());
    if (seen) err(line, `${v.name} is already in ${h.name} (line ${seen}).`);
    else {
      entry.guestLines.set(v.name!.toLowerCase(), line);
      h.guests.push({ name: v.name!, ageGroup: (v.age_group || 'adult') as ImportGuest['ageGroup'], partnerStatus: (v.partner_status || 'none') as ImportGuest['partnerStatus'], inWeddingParty: v.wedding_party?.toLowerCase() === 'yes' });
    }
  }
  return errors.length ? { households: [], errors } : { households: [...byName.values()].map((e) => e.h), errors: [] };
}
