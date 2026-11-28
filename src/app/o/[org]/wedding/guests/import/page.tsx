import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { NoWedding, WeddingNav } from '../../bits';
import { view } from '../../view';
import { importGuests } from '../actions';
import { GuestNav } from '../nav';

export const metadata = { title: 'Import guests' };

// PRD P0-3: guest import via validated CSV. Pasted text, not a file (no upload exists yet). Preview first; then all or nothing.
export default async function ImportGuests({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'guests.edit', async () => ({}));
  if (!data) return <NoWedding slug={ctx.slug} />;
  return (
    <main>
      <WeddingNav slug={ctx.slug} mode={data.v.wedding.mode} />
      <GuestNav slug={ctx.slug} />
      <h1>Import guests</h1>
      <p>Paste rows from a spreadsheet saved as CSV. One row per person; rows with the same household name become one invitation. The first line names the columns.</p>
      <p>Columns: <code>household</code> and <code>name</code> are required. Optional: <code>email</code>, <code>phone</code>, <code>list</code> (A or B), <code>priority</code>, <code>age_group</code> (adult, child, infant), <code>partner_status</code> (none, dating, long_distance, engaged, married), <code>wedding_party</code> (yes or no), <code>address1</code>, <code>city</code>, <code>region</code>, <code>postal</code>.</p>
      <ActionForm action={importGuests.bind(null, ctx.slug)}>
        <label>CSV <textarea name="csv" rows={12} cols={80} required maxLength={200000} placeholder={'household,name,email,list\nThe Lindqvists,Linda Lindqvist,linda@example.com,A'} /></label>
        <label><input type="checkbox" name="confirm" /> I have checked the preview: import these guests</label>
        <button type="submit">Check or import</button>
      </ActionForm>
      <p>Without the box ticked, this only checks the text and says what it would add. A problem on any line means nothing is imported.</p>
    </main>
  );
}
