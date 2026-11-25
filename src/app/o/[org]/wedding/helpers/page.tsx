import { inOrg, requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { PLAIN_GRANT_SCOPES, SCOPE_LABEL, type GrantScope } from '@/lib/knotwork/access';
import { grantHelper, revokeHelper } from '../actions';
import { NoWedding, WeddingNav } from '../bits';
import { view } from '../view';

export const metadata = { title: 'Helpers' };

// PRD P0-2: helper permissions are scoped grants. Partners (owners) manage them. Inviting a helper is the template's
// Members page; a helper with no grant sees the schedule and their own tasks.
export default async function Helpers({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'helpers.manage', async (tx) => ({
    members: await tx.membership.findMany({ where: { ...inOrg(ctx), role: { not: 'owner' } }, select: { userId: true, role: true, user: { select: { email: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
    grants: await tx.helperGrant.findMany({ where: inOrg(ctx), orderBy: { createdAt: 'asc' } }),
  }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { members, grants } = data;
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  return (
    <main>
      <WeddingNav slug={ctx.slug} life={data.v.wedding.mode === 'life'} />
      <h1>Helpers</h1>
      <p>Everyone here who is not one of the two partners. A helper always sees the schedule and can move their own tasks along; anything else is a permission you give. No permission lets a helper approve anything.</p>
      {members.length === 0 && <p>No helpers yet. Invite one from Members, as a member.</p>}
      {members.map((m) => {
        const theirs = grants.filter((g) => g.userId === m.userId);
        const missing = PLAIN_GRANT_SCOPES.filter((s) => !theirs.some((g) => g.scope === s)); // funder: linked on the Funding page
        return (
          <section key={m.userId} aria-label={`Helper ${m.user.email}`}>
            <h2>{m.user.name || m.user.email}</h2>
            <ul>
              {theirs.map((g) => (
                <li key={g.id}>
                  {SCOPE_LABEL[g.scope as GrantScope]}
                  <ActionForm action={bind(revokeHelper)}>
                    <input type="hidden" name="id" value={g.id} />
                    <button type="submit">Remove</button>
                  </ActionForm>
                </li>
              ))}
            </ul>
            {missing.length > 0 && (
              <ActionForm action={bind(grantHelper)}>
                <input type="hidden" name="userId" value={m.userId} />
                <select name="scope" aria-label={`Permission for ${m.user.email}`}>{missing.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}</select>
                <button type="submit">Give permission</button>
              </ActionForm>
            )}
          </section>
        );
      })}
    </main>
  );
}
