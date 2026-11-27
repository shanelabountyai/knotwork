import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { showDay } from '@/lib/knotwork/days';
import { JURISDICTIONS } from '@/lib/knotwork/namechange/rules';
import { nameChangeView, type NameChangeCard } from '@/lib/knotwork/namechange/store';
import { NoWedding, WeddingNav } from '../bits';
import { nameOf, view } from '../view';
import { changeJurisdiction, holdNameChangeArtifact, moveNameChangeStep, removeNameChange, shareNameChange, startNameChange } from './actions';

export const metadata = { title: 'Name change' };

const STATUS = { todo: 'not started', started: 'in progress', done: 'done' } as const;

// PRD P1-4, the name-change sequence: an ordered workflow (federal, then state, passport, accounts) from rules kept as
// data, one per jurisdiction, ILLUSTRATIVE ONLY. A step can be started or finished only when the steps it waits for are
// done and the documents it needs are held (the buttons are always there; the store refuses, naming what is missing). Each partner's is their own and private unless they share it (D-114);
// helpers never see this page. Every "from" day is the wedding date plus an offset, worked out on this request.
export default async function NameChange({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const data = await view(ctx, 'namechange.own', async (tx, v) => ({ nc: await nameChangeView(tx, ctx, v) }));
  if (!data) return <NoWedding slug={ctx.slug} />;
  const { v, nc } = data;
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);
  return (
    <main>
      <WeddingNav who={v.who} slug={ctx.slug} life={v.wedding.mode === 'life'} />
      <h1>Name change</h1>
      <p role="note"><strong>Illustrative only, not legal advice.</strong> These steps are an example of a typical order, not the rules of any office. Knotwork knows nothing about current forms, fees or waiting times; check each office&apos;s own instructions.</p>

      {nc.mine ? <Mine card={nc.mine} bind={bind} /> : (
        <section aria-label="Start a name change">
          <h2>Your name change</h2>
          <p>Only you will see it unless you share it with your partner. Helpers never see it.</p>
          <ActionForm action={bind(startNameChange)}>
            <label>Where you live <select name="jurisdiction" defaultValue={JURISDICTIONS[0]!.key}>
              {JURISDICTIONS.map((j) => <option key={j.key} value={j.key}>{j.name}</option>)}
            </select></label>
            <button type="submit">Start my name change</button>
          </ActionForm>
        </section>
      )}

      {nc.others.map((o) => (
        <section key={o.userId} aria-label={`${nameOf(v, o.userId)}'s name change`}>
          <h2>{nameOf(v, o.userId)}&apos;s name change (shared with you)</h2>
          <Steps card={o} />
        </section>
      ))}
    </main>
  );
}

type Bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => (...a: A) => R;

function Mine({ card, bind }: { card: NameChangeCard; bind: Bind }) {
  const { rules, board } = card;
  return (
    <section aria-label="Your name change">
      <h2>Your name change</h2>
      <p>
        Following: <strong>{rules.name}</strong>. {board.done} of {board.total} steps done. {card.shared ? 'Shared with your partner (they can read it, not change it).' : 'Private to you.'}
      </p>
      <p><small>{rules.notice}</small></p>
      <ActionForm action={bind(shareNameChange)}>
        <input type="hidden" name="shared" value={card.shared ? '' : 'on'} />
        <button type="submit">{card.shared ? 'Make it private again' : 'Share it with my partner'}</button>
      </ActionForm>

      <h3>Documents</h3>
      <ul aria-label="Documents">
        {board.artifacts.map((a) => (
          <li key={a.key} aria-label={`Document ${a.label}`}>
            {a.label}: <strong>{a.held ? 'held' : 'not held'}</strong>
            {a.producedByTitle && !a.held && <small> (comes out of &quot;{a.producedByTitle}&quot;)</small>}
            <ActionForm action={bind(holdNameChangeArtifact)}>
              <input type="hidden" name="artifact" value={a.key} />
              <input type="hidden" name="op" value={a.held ? 'release' : 'hold'} />
              <button type="submit">{a.held ? `I no longer have: ${a.label}` : `I have: ${a.label}`}</button>
            </ActionForm>
          </li>
        ))}
      </ul>

      <h3>Steps, in order</h3>
      <Steps card={card} bind={bind} />

      <details>
        <summary>Change the rules it follows, or remove it</summary>
        <ActionForm action={bind(changeJurisdiction)}>
          <label>Where you live <select name="jurisdiction" defaultValue={rules.jurisdiction}>
            {JURISDICTIONS.map((j) => <option key={j.key} value={j.key}>{j.name}</option>)}
          </select></label>
          <button type="submit">Use these rules instead</button>
          <p><small>Only before any step is started.</small></p>
        </ActionForm>
        <ActionForm action={bind(removeNameChange)}>
          <label><input type="checkbox" name="confirm" /> Yes, remove my name change and everything I marked in it</label>
          <button type="submit">Remove my name change</button>
        </ActionForm>
      </details>
    </section>
  );
}

/** The steps by phase. With `bind`, the owner's buttons; without, read-only (the other partner's shared view). */
function Steps({ card, bind }: { card: NameChangeCard; bind?: Bind }) {
  const move = (step: string, op: 'start' | 'finish' | 'stop' | 'reopen', text: string) => bind && (
    <ActionForm action={bind(moveNameChangeStep)}>
      <input type="hidden" name="step" value={step} />
      <input type="hidden" name="op" value={op} />
      <button type="submit">{text}</button>
    </ActionForm>
  );
  return (
    <>
      {card.board.phases.map((ph) => (
        <section key={ph.phase} aria-label={`${ph.label} steps`}>
          <h4>{ph.label}</h4>
          <ol>
            {ph.steps.map((s) => (
              <li key={s.key} aria-label={`Step ${s.title}`}>
                <strong>{s.title}</strong>: {STATUS[s.status]}{s.completedOn && ` (done ${showDay(s.completedOn)})`}. <small>From {showDay(s.from)} ({s.startAfterDays} days after the wedding, a planning placeholder).</small>
                <br /><small>{s.notes}</small>
                {s.status !== 'done' && s.waitingFor.length > 0 && <><br />Waits for: {s.waitingFor.join('; ')}</>}
                {s.status !== 'done' && s.needs.length > 0 && <><br />Needs: {s.needs.join('; ')}</>}
                {s.status === 'todo' && (s.canStart ? <><br /><em>Ready to start.</em></> : null)}
                {s.status === 'todo' && move(s.key, 'start', `Start: ${s.title}`)}
                {s.status !== 'done' && move(s.key, 'finish', `Mark done: ${s.title}`)}
                {s.status === 'started' && move(s.key, 'stop', `Not started after all: ${s.title}`)}
                {s.status === 'done' && move(s.key, 'reopen', `Reopen: ${s.title}`)}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
