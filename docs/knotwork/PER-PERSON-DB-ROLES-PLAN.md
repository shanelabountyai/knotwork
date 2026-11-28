# Knotwork — plan: a database identity per person (closing D-172 finding 1)

Written 2026-11-28. **A plan only: no code, migration, schema, test or dependency changes are in this PR.** Knotwork is
not deployed and holds synthetic data only. Read against `main` at `1c4e4c0` and PR #9 (`fix/d172-guards` at `0d5154d`,
an open draft, not merged). This plan assumes PR #9 merges first; it does not touch it.

Shane's decision (2026-11-28): each person gets their own database identity before any real couple uses Knotwork, so
the open half of D-172 finding 1 (recorded in D-190, PR #9) can be closed.

**In one paragraph.** A role per person only helps if nobody else can become that role. `SET ROLE` from the app's one
login (option A) does not do that: the same raw SQL can switch roles too. What closes the finding is a proof that only
the person holds, checked inside the database, with its check value somewhere the app's login cannot read or write.
Two designs do that: a real Postgres login per partner on its own connection (option C, the decision as worded), or a
per-partner key checked by a database function (option D). They close the same things; D costs less and works on every
host. **Recommended: D, built behind one function (`knotwork_actor()`), so C can replace it later without touching
the guards.** Shane decides (question 1).

**Two things came out of the work that are bigger than the identity question, and the plan now includes both.**
(1) Every guard trigger Knotwork has today can be fooled from the app's login with a temporary table, with no forged
approval at all (section 1, fact 4; reproduced on a scratch Postgres 16). (2) A trusted identity is worth nothing
while one partner can invent a third owner, or re-enrol the other partner's key; so the owner set is frozen at
pairing and a lost key is reset only by the operator (sections 2 D, 5, and questions 4 and 6).

---

## 1. The current state

### How the app connects, and which roles exist

- Two Prisma clients over `pg` pools. `db` uses `DATABASE_URL` (`src/core/db/index.ts:19`); `dbSystem` uses
  `DATABASE_URL_SYSTEM` and is the same client as `db` when that is unset (`src/core/db/system.ts:11`).
- Two database roles, made by `scripts/db-setup.ts`: the **owner** (migrates, owns every table, bypasses RLS) and
  **`<name>_app_rw`** (`LOGIN NOBYPASSRLS NOSUPERUSER`, lines 18 to 27), granted `SELECT, INSERT, UPDATE, DELETE` on
  every table in `public` (lines 38 to 42).
- **RLS is off by default.** `db-setup.ts` writes `DATABASE_URL` as the owner and leaves `RLS_MODE=enforce` commented
  out (lines 71 to 78). In off mode the running app *is* the owner role. In enforce mode `DATABASE_URL` is `app_rw` and
  the owner is used only through `asSystem`, from the closed list in `src/core/db/cross-org.ts` (INV-32).
- There is **no role per person**. Every signed-in person, helper, guest link and cron run shares those one or two
  logins.

### How RLS learns who is asking today

It does not learn *who*. It learns *which workspace*. `withOrg` opens a transaction and runs
`set_config('app.org_id', <orgId>, true)` (`src/core/db/rls.ts:15-21`); every policy compares `"orgId"` with
`current_setting('app.org_id', true)` (`prisma/migrations/20261105000000_rls_policies/migration.sql:11`; the same
expression appears 1,086 times across the policy migrations, and no migration reads `current_user` or `session_user`).
The person exists only in the app: the session cookie is hashed and looked up in `Session`
(`src/core/auth/session.ts:73-87`), `requireOrg` reads the membership (`src/core/authz/guards.ts:24-45`), and
`ctx.userId` is written into rows as plain data (`src/lib/knotwork/consent/store.ts:28` and `:78`).

### Why a trigger cannot trust any of that

1. **One login.** `current_user` and `session_user` are the same for both partners, so they say nothing.
2. **A session setting is a claim, not a proof.** Postgres accepts any two-part setting name from any role
   ([custom options](https://www.postgresql.org/docs/current/runtime-config-custom.html)). Whoever can run SQL on the
   app's login can run `set_config('app.user_id', '<the other partner>', true)` first. D-190 says exactly this and
   rejected the idea for that reason.
3. **The ids are just columns.** `ConsentRequest.proposerId` and `deciderId` are UUIDs the writer supplies. The checks
   that exist compare them with each other and with `Membership`: `ConsentRequest_two_key_check` (decider is not the
   proposer, `20261123000001_knotwork_phase1/migration.sql:410`), `ConsentRequest_insert_guard` and the solo rule
   (`20261124000000_knotwork_solo/migration.sql:20-49`), and PR #9's `ConsentRequest_partner_guard` (the decider is an
   owner of that workspace). None can tell *who typed the statement*.
4. **The designated-field guards inherit the gap.** `knotwork_require_approved`, `Vendor_guard`, `Wedding_guard`,
   `Expense_guard`, `Wedding_mode_guard`, `Wedding_request_once` and PR #9's five triggers all ask "is there an approved
   request?". A forged approval satisfies every one of them. PR #9's own tests use this: the `forged()` helper in
   `tests/knotwork/guard-d172.test.ts` builds approved requests with raw SQL, and one test pins the gap open.

### Four more facts the options must face (each checked in the code)

- **The app's login can forge a web session.** `Session` has no `orgId`, so no RLS policy; `app_rw` holds `INSERT` on
  it; and the app itself inserts sessions as `db` (`src/core/auth/session.ts:60-65`). Raw SQL on the app's login can
  insert a `Session` row for the other partner with a token it chose, then use the real app as them. **Any design
  whose proof is derived from the web session is one more line in the forger's script.**
- **The owner role can never be bound by a trigger.** A table's owner can disable its triggers; the tests do so
  (D-172, D-197). So "raw SQL as the owner role" is closed only by the app not *being* the owner: enforce mode has to
  be on. And the running app still holds the owner URL for `asSystem`. That is a floor under every option.
- **CI does not appear to run the enforce leg for Knotwork today.** The matrix adds it only when the repo variable
  `RLS_ENFORCE` is `1` (`.github/workflows/ci.yml:17`). The check runs listed by the GitHub API for `main` at
  `1c4e4c0` are `ci (off)`, `modules-removed` and `oracles`: no `ci (enforce)`. The variable itself could not be read
  from this session, and the reviewer could not repeat the check-run lookup (see "Not verified").
- **Fact 4: a temporary table fools every guard, today.** No Knotwork guard function sets `search_path` (only the
  template's `org_event_assign_seq` does, `20261108000000_org_events/migration.sql:28`), and they name their tables
  unqualified (`"ConsentRequest"`, `"Membership"`, `"Wedding"`, `"Org"`). Postgres looks in the session's temporary
  schema first for tables, and every role may create temporary tables by default. So the app's login can
  `CREATE TEMP TABLE "ConsentRequest" (...)`, insert an "approved" row, and `knotwork_require_approved` finds it; a
  temporary `"Membership"` satisfies PR #9's `ConsentRequest_partner_guard` the same way. **Reproduced on a scratch
  Postgres 16 with a guard of the same shape, as a non-owner `NOBYPASSRLS` role: refused without the temporary
  table, passed with it; refused again once the function had `SET search_path = pg_catalog, public, pg_temp`.** Not
  run against Knotwork's own schema. (A temporary *function* did not shadow a real one in the same test: Postgres
  never searches the temporary schema for functions.) This is independent of finding 1 and should be fixed first
  (section 6, step 0).

### Who the attacker is

| | Actor | Today |
|---|---|---|
| T1 | A partner using the app's pages | Closed by the app (`transition`, `consent/machine.ts:55-65`) |
| T2 | SQL injected through an app bug, running on the app's login. (Near-theoretical today: the reviewer found no unsafe raw query in `src/` beyond savepoints. An injection inside the victim's *own* consent transaction would run with the victim's proof, and no option here helps with that) | Open |
| T3 | Someone holding the app's `DATABASE_URL` (a leaked env value) | Open |
| T4 | Someone holding the owner URL, or the host's console (Shane, the host's staff) | Open, and stays open in every option |
| T5 | Full control of the running server (all env values, all code) | Open; narrowed by C and D, never closed |

Finding 1, as D-172 and D-190 record it, is T2 and T3: raw SQL, past all app code, approving as the other partner or
inventing a proposer.

---

## 2. The options

### A. A Postgres role per person, `SET ROLE` per transaction from the pooled login

**How.** Create `NOLOGIN` roles, one per person, grant each to the app's login, run `SET LOCAL ROLE <person>` at the
start of each transaction; triggers read `current_user`. This is what PostgREST does: its `authenticator` login "becomes"
other roles with `SET LOCAL ROLE`, after `GRANT user TO authenticator`
([PostgREST auth](https://docs.postgrest.org/en/stable/references/auth.html)).

**Closes.** Nothing in finding 1. `SET ROLE` needs only that the *session* user holds the role, and `RESET ROLE` "can
be executed by any user" ([SET ROLE](https://www.postgresql.org/docs/current/sql-set-role.html)). Raw SQL on the app's
login runs `SET ROLE <other partner>` exactly as the app would. It is D-190's rejected option (b) with a role name in
place of a setting. Revoking the right (`GRANT ... WITH SET FALSE`,
[GRANT](https://www.postgresql.org/docs/current/sql-grant.html)) stops the app too, and `SET ROLE` cannot be wrapped in
a checking function: it "cannot be used within a `SECURITY DEFINER` function".

**Leaves open.** T2 to T5. **Cost.** Medium: role lifecycle, a role with `CREATEROLE`, grants for every person role.
**Risks.** It looks like a fix. Transaction poolers never support session-level `SET`
([PgBouncer features](https://www.pgbouncer.org/features.html)); `SET LOCAL` inside a transaction is the only safe form.

### B. A signed identity per request, verified inside the database

**How.** The app (B1) or an outside identity provider (B2) signs a short-lived token naming the user; a
`SECURITY DEFINER` function verifies the signature and the triggers use its answer.

A correction to the usual shorthand: **Supabase does not verify the token inside the database.** PostgREST verifies
it ("It is PostgREST's job to authenticate requests"), switches role, and exposes the claims as the setting
`request.jwt.claims`, which `auth.uid()` reads
([PostgREST auth](https://docs.postgrest.org/en/stable/references/auth.html),
[Supabase discussion 19695](https://github.com/orgs/supabase/discussions/19695)). Neon's docs say of that same
setting: "`request.jwt.claims` is a regular Postgres parameter that can be modified by any database user"
([pg_session_jwt](https://neon.com/docs/extensions/pg_session_jwt)). Knotwork talks to Postgres through Prisma, not
PostgREST, so nothing would verify anything. Real in-database verification does exist: Neon's `pg_session_jwt` checks
signatures when given a JWK (it powers Neon's Data API), or an HMAC check written with `pgcrypto`.

**Closes.** Raw SQL that writes `ConsentRequest` directly (T2, T3), if the signing secret is not readable by the
app's login.

**Leaves open.** B1 signs for whoever the web session says, and the app's login can forge a web session (section 1).
The forger inserts a `Session` row, then lets the app sign for them. So B1 moves the gap; it does not close it, unless
every auth table is also taken away from the app's login, which is a rewrite of template-owned `src/core/auth`. B2
closes that route but replaces the template's sign-in with a vendor, and needs an extension most hosts do not offer
for plain Postgres connections.

**Cost.** B1 small, B2 large. **Risks.** B1 is easy to believe in; B2 ties the design to a host and an account.

### C. A separate login per partner, on its own connection

**How.** Each partner has a `LOGIN` role. The password is a key the server never stores: it lives on the partner's
device and is sent with the request; the server opens a short connection as that role for the consent transaction
only (`propose`, `decide`). Triggers map `session_user` to a user id through a table only the owner can write.

**Closes.** T2 and T3. `session_user` cannot be changed without superuser
([SET SESSION AUTHORIZATION](https://www.postgresql.org/docs/current/sql-set-session-authorization.html)); the
password check value sits in the role catalog, which the app's login cannot read or write; and a forged web session
does not carry the other partner's key. This is the decision as worded, in the one form that works.

**Leaves open.** T4. T5 in part (a controlled server sees a key when its owner next uses it). It has D's
enrolment gap, its reset route and its third-owner route (see D), and needs the same fixes. Whoever holds the role-creating credential can reset a partner's password, and
that credential has to live somewhere the app can reach to enrol people.

**Cost.** High. A role-creating credential in the server; role lifecycle (create, drop, rename on account deletion);
grants and RLS for a group role; one new connection per approval (the handshake on every one, from a serverless
function); a Prisma client per person (`newClient` exists, `src/core/db/index.ts:15`); tests that create real roles;
`seed-couple.ts` runs both partners in one transaction today (`scripts/knotwork/seed-couple.ts:62-64`) and would have
to split. Host limits apply (section 4): Neon caps a branch at 500 roles, RDS Proxy needs a stored secret per
database user.

**Risks.** Roles are global to the server, not to a database: a leftover role outlives a dropped database. Postgres
has no login lock-out, so the key must be random, never chosen.

### D. A key per partner, checked by the database (found while reading; recommended)

**How.** The same proof as C, without the roles.

- A table in a schema the app's login has no rights on (`knotwork_private.partner_key`: user id, the SHA-256 of the
  key). `sha256` is built into Postgres
  ([binary string functions](https://www.postgresql.org/docs/current/functions-binarystring.html)); no extension.
  The template already stores every bearer token this way (`src/core/tokens.ts`, INV-07).
- The key is random (256 bits), made at enrolment, kept in an `httpOnly` `__Host-` cookie on the partner's device and
  shown once so it can be typed on another device.
- In the consent transaction the app runs `set_config('knotwork.actor_key', <key>, true)`, transaction-local, the
  same shape as `app.org_id` and inside INV-31's rule (`tests/invariants/inv-29-33-rls.test.ts:25-33`).
- The functions live in `public` (the app's login must be able to call them; a migration cannot grant to the app
  role by name, since it is `<name>_app_rw` locally and `app_rw` in CI). Only the table is in the private schema,
  always written schema-qualified. Every function, and the new trigger function, carries
  `SET search_path = pg_catalog, public, pg_temp` (fact 4).
- `knotwork_actor()` (`SECURITY DEFINER`, as `org_event_assign_seq` already is) hashes the
  setting and returns the matching user id, or NULL. Anyone can *set* the setting; only the key holder can set it to
  something that *matches*. That is the answer to D-190's objection.
- Guards call `knotwork_actor()` (section 5).

**Closes.** T2 and T3, the same as C: raw SQL on the app's login does not have the other partner's key, cannot read
or write the table of hashes, cannot change the functions or triggers (it does not own them), and a forged web
session does not carry the key.

**Leaves open.** T4. T5 in part, as C.

**The enrolment gap, stated exactly (the review's must-fix 4).** The enrol function has to be callable by the app's
login, with the user id as an argument, so it does not "trust the web session": it trusts *whoever reaches the app's
login first*, once per user id. A forger with raw SQL can enrol a key in the other partner's name before that partner
ever does. What limits it: it is latched (a second enrolment is refused, so the real partner *cannot* enrol and the
app tells them a key already exists that is not on their device); it writes an audit line the app's login cannot
remove (`AuditEvent` is append-only); and every partner page shows whether this device holds the enrolled key. The
only remedy is an operator reset. So the true claim is: **closed for a partner who enrolled their own key.** Nothing
the database can check distinguishes the real second partner from one the first partner made up at the first moment;
option C has the same gap through its role-creating credential.

**Two routes that must be shut in the same change, or D closes nothing (the review's must-fix 1 and 2):**
- *Reset, then enrol.* If one partner's key could reset the other's, raw SQL would reset, enrol a new key in the
  other's name, and approve. So there is **no reset the app's login can call**: a lost key is reset by the operator,
  as the owner role, out of band (question 4).
- *A made-up third owner.* `User` has no `orgId` and the app's login may insert into it and into `Membership`; an
  owner may make owners (`mayAssign`, `src/core/authz/permissions.ts:20-21`); nothing caps owners at two. Raw SQL
  inserts a user, makes it an owner, enrols its key and approves as it, every id honestly "proven". So **the owner set
  freezes at pairing** (section 5): a workspace with a wedding never has more than two owners, and once paired no
  membership becomes an owner. Replacing a partner becomes an operator act.

**Cost.** Low to medium. One private schema, one table, three small functions (actor, enrol, change), two triggers,
one cookie, an enrolment screen, an operator reset script. No `CREATEROLE`, no per-person connection, no extension,
no change to template-owned files (the owner-set trigger sits on the template's `Membership` table from a clone
migration, as D-56's pairing latch already does).

**Risks.**
- The key travels as a query parameter in one statement per consent transaction. A server that logs parameters would
  log it. Mitigation: keep parameter logging off; or the stronger variant, where the database stores the key itself
  (owner-only) and the app sends an HMAC over the transaction id (one more round trip to read it; the key still
  sits in the cookie, so this only keeps it out of logs). Decide at build time.
- RDS Proxy may pin a connection on `set_config` (section 4). The app already does this for `app.org_id`, so D adds
  no new pin.
- A lost key means waiting for the operator. That is the price of recovery not being a back door (question 4).
- The owner-set freeze may meet a template test that makes three owners in one org; the rule is scoped to orgs that
  have a wedding for that reason. To be proven by the gate.

### E. A passkey signature per approval (strongest, not for now)

Each partner's device holds a private key; the database stores the public key and verifies a signature over the
request id and payload. Even a controlled server cannot approve for an absent partner. It needs signature
verification inside Postgres (an extension), WebAuthn work in the app, and the same enrolment and recovery questions.
A later step that would sit behind the same `knotwork_actor()` seam.

### Side by side

| | A: `SET ROLE` | B1: app-signed | C: login per partner | D: key checked in DB |
|---|---|---|---|---|
| T2 injected SQL approves as the other partner | open | closed directly, open through a forged session | **closed**, for a self-enrolled partner | **closed**, for a self-enrolled partner |
| T3 leaked app URL | open | same as T2 | **closed** | **closed** |
| Inventing a proposer | open | same as T2 | **closed** | **closed** |
| T4 owner URL, host console | open | open | open | open |
| T5 whole server | open | open | partly | partly |
| Needs a role-creating credential at run time | yes | no | yes | no |
| Extra connection per approval | no | no | yes | no |
| Template-owned files changed | no | yes, to really close | no | no |
| Works behind a transaction pooler | yes (`SET LOCAL`) | yes | yes, a pool per person | yes |
| Host limits | role count | extension for B2 | role count, proxy secrets | none found |

---

## 3. Recommendation

**Option D, with every guard reading one function, `knotwork_actor()`.**

1. It closes what finding 1 names (T2, T3: approve as the other partner, invent a proposer), and the forged-session
   route that A and B1 leave.
2. It closes exactly what C closes. C's extra strength (Postgres checks the password itself) is real, but C also adds
   a role-creating credential to the server, a connection per approval and host limits, and it buys nothing against T4
   or T5 that D does not.
3. It needs nothing from a host, so the hosting choice stays open.
4. It changes no template-owned path (`src/core`, CLAUDE.md "Foundation rules"). The setting is set in Knotwork's own
   `consent/store.ts`, inside the transaction `withOrg` already opened.
5. The seam keeps the decision reversible: C (or E) later means a new body for `knotwork_actor()`, not new guards.

**What "closed" will mean, stated honestly in the D-row:** for a partner who enrolled their own key, with the app
running as `app_rw` (enforce mode), the guards' `search_path` pinned and the owner set frozen at pairing, raw SQL on
the app's login can neither approve as that partner, nor invent a proposer, nor invent a decider. Not closed, and not
closable by a trigger: the owner URL, the host's console, a fully controlled server, and a key enrolled in a
partner's name before they enrolled it themselves (visible to them, fixed only by the operator).

D is not "a login per person" as the decision was worded. If Shane wants the literal form, it is C, and sections 5 to
6 apply unchanged apart from the body of `knotwork_actor()` and the costs listed under C.

---

## 4. What each hosting choice means (no host is chosen here)

Common ground. A transaction pooler hands the server connection back after each transaction, so session-level
`SET`/`RESET` is never safe ([PgBouncer features](https://www.pgbouncer.org/features.html)); `SET LOCAL` and
`set_config(..., true)` end with the transaction ([SET](https://www.postgresql.org/docs/current/sql-set.html)). The
template already proved the second form through Neon's pooler (spike S4a, `spikes/s4/s4.ts`, README "Row-level
security on Neon"). PgBouncer keeps a pool per user and database pair
([config](https://www.pgbouncer.org/config.html)), so every per-person login (C) is its own pool.

| Host | Pooler and session state | Per-person roles (A, C) | Verified identity (B) | Option D |
|---|---|---|---|---|
| **Neon** | PgBouncer in transaction mode; `SET`/`RESET` not supported on pooled connections; up to 10,000 client connections; each pool may grow to 90% of `max_connections` ([pooling](https://neon.com/docs/connect/connection-pooling)) | Allowed, made in SQL; SQL-made roles are not `neon_superuser`. **500 roles per branch**; passwords need 60 bits of entropy ([roles](https://neon.com/docs/manage/roles)). At two roles a couple, about 250 couples a branch | `pg_session_jwt` verifies with a JWK and powers the Data API; the fallback setting is forgeable by any user ([docs](https://neon.com/docs/extensions/pg_session_jwt)). Not shown for a pooled Prisma connection | Works: the same mechanism as today's `app.org_id` |
| **Supabase** | Supavisor: session mode on 5432, transaction mode on 6543; transaction mode has no session state and, on the shared pooler, no prepared statements ([connecting](https://supabase.com/docs/guides/database/connecting-to-postgres)) | Allowed: `create role ... with login password`; through the shared pooler the user name is `[ROLE].[PROJECT-REF]`. `postgres` is not a superuser ([roles](https://supabase.com/docs/guides/database/postgres/roles), [superuser](https://supabase.com/docs/guides/database/postgres/roles-superuser)) | `auth.uid()` reads a setting PostgREST fills; nothing verifies on a direct Prisma connection (option B above) | Works |
| **RDS / Aurora** | No pooler unless RDS Proxy is added. The proxy pins on `SET`; `SET LOCAL` in an explicit transaction does not pin, the page as fetched says `set_config(name, value, true)` **does** (the reviewer could not confirm that sentence) ([pinning](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html)) | Allowed: the master user is `NOSUPERUSER CREATEROLE` ([rds_superuser](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html)). Through the proxy each database user needs its own Secrets Manager secret added to the proxy, or end-to-end IAM ([new user](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-new-db-user.html)): impractical per partner | Only what you install | Works. Through the proxy both `withOrg` (today) and D pin for their transaction; without the proxy, no issue |
| **Self-hosted** | Your own PgBouncer; `auth_query` lets it accept users not in its file ([config](https://www.pgbouncer.org/config.html)) | Allowed, no limits but your own; a real superuser exists, so T4 is wider | Any extension you build and maintain | Works |

Reading it: A is possible everywhere and useless everywhere. C is possible everywhere but capped on Neon and awkward
behind RDS Proxy. B2 fits only where the host verifies for you. D asks nothing of the host.

---

## 5. How the guards change

All new rules are **new triggers in a new migration**, named to fire after the guards they complete, with no
`CREATE OR REPLACE` of an old function (D-196's convention). On `ConsentRequest` the existing BEFORE triggers are
`ConsentRequest_guard`, `ConsentRequest_insert_guard` and (PR #9) `ConsentRequest_partner_guard`; the new one is named
to sort after all three (for example `ConsentRequest_proven_actor`), so every old refusal still comes first with its
old sentence.

| Moment | Today | Added rule |
|---|---|---|
| **Insert (the proposer)** | born pending, unsigned (`ConsentRequest_insert_guard`); `proposerId` unchecked (D-190, D-198 should-fix 3) | `knotwork_actor()` is not NULL, equals `NEW."proposerId"`, and is an owner of `NEW."orgId"` now. Closes "inventing a proposer" |
| **Approve, two keys (the decider)** | decider is not the proposer; decider is an owner (PR #9) | `knotwork_actor()` equals `NEW."deciderId"`. Closes "approve as the other partner" |
| **Approve, solo (D-33)** | one owner, who is the proposer, never paired (`knotwork_request_guard`) | `knotwork_actor()` equals `NEW."proposerId"`. A solo partner still acts alone; nobody else can do it in their name |
| **Decline** | decider recorded | `knotwork_actor()` equals `NEW."deciderId"` (executes nothing; kept for a true record) |
| **Withdraw** | none | `knotwork_actor()` equals `OLD."proposerId"` |
| **Expire** | none | none: the lazy sweep and cron have no person (`expireDue`, `consent/store.ts:47-54`), and expiry executes nothing |

- **The proposer is checked at insert only.** D-190 left a proposer check out because, at approval, it would refuse a
  request whose proposer has since left the workspace, which the app allows. Checking at insert avoids that: the
  proposer had to be a present, proven owner when they asked.
- **The designated-field guards do not change.** `knotwork_require_approved` and the vendor, wedding, expense, guest
  and mode guards keep asking for an approved request. Once an approval cannot be forged, that question means what
  it was meant to.
- **Solo mode (D-33) and the pairing latch (D-56) do not change.** `Membership_pairing_latch` still sets `pairedAt`.
- **`knotwork_actor()`** treats an unset setting and an empty one alike (a transaction-local setting reads `''`
  afterwards, `scripts/rls-policies.ts:9`).
- **Enrolment** is two functions the app's login may call: enrol (refused if the user already has a key) and change
  (needs the old key). **There is no reset function.** A reset is the operator deleting the key row as the owner
  role. Each enrolment and change writes an audit line, as the pairing latch does.
- **The owner set (new trigger on `Membership`, and one on `Wedding` insert).** A workspace that has a wedding never
  has more than two owners; once `pairedAt` is set, no membership is inserted as, or changed to, `owner`. Removal is
  still allowed (a request then simply has nobody to approve it). Named to fire with the pairing latch's own lock on
  the `Org` row, so two arrivals are counted one after the other.
- **Every new and existing guard function gets `SET search_path = pg_catalog, public, pg_temp`** (fact 4). For the
  existing ones that is `ALTER FUNCTION ... SET`, which changes no function body and edits no applied migration.
- **App side, Knotwork-owned files only.** The key is read from the cookie and set **inside `propose()` and
  `decide()`** (`consent/store.ts`), not by each caller, so none of the callers can forget it: `wedding/actions.ts`
  (five `propose` sites), `guests/actions.ts`, `life/actions.ts`, `contingency/store.ts`. A structure test holds
  that. `executeApproved` is untouched apart from its header comment.

---

## 6. Migration, rollout, tests, CI

### Before anything

PR #9 merges (this plan builds on `ConsentRequest_partner_guard` and `guard-d172.test.ts`). Shane answers questions
1 to 5.

### Steps (each its own draft PR; each adds a migration, so none merges by the loop)

0. **Pin the guards' `search_path` (fact 4).** One migration of `ALTER FUNCTION ... SET search_path` for every
   Knotwork guard function, PR #9's included, and an enforce-leg test that a temporary `"ConsentRequest"`,
   `"Membership"`, `"Wedding"` or `"Org"` changes no guard's answer. Independent of everything else here, and worth
   doing even if the rest waits.
1. **Enforce mode for Knotwork.** Turn on the CI enforce leg (the repo variable, Shane's action) and fix whatever it
   finds. No guard yet. Without this the app runs as the owner and nothing below binds it.
2. **Keys, not yet required.** Migration: the private schema, the key table, `knotwork_actor()`, enrol and change.
   App: the cookie, the enrolment screen, typing a key on another device, the "is this device enrolled" line, the
   operator's reset script. Seeds enrol the synthetic
   couple. Guards unchanged, so nothing can be refused yet.
3. **Guards on.** Migration: the new `ConsentRequest` trigger and the owner-set triggers. App: `propose` and `decide` send the key. `seed-couple.ts` sets each
   partner's key before their step (it runs both in one transaction, which D allows). Tests below.
4. **Docs.** The D-rows below, NEXT.md, CLAUDE.md rule 2, a hosting note in `PRODUCTIONIZE.md`.

No data migration: there is no deployed database, and old approved rows are not re-checked (the triggers fire on new
writes). Local databases are re-seeded. Reversal at any step: drop the trigger in a new migration.

### Tests

Attacks, each by raw SQL after the real actions, each failing when its trigger is switched off (D-197's method):

1. Approve naming the real other partner, no key set: refused.
2. The same with the forger's own key set: refused.
3. Insert a request with a made-up proposer, or with the other partner as proposer: refused.
4. Insert a `Session` row for the other partner and approve through the real action as them: refused by the database.
5. Set the setting to the stored hash, to garbage, to another workspace's partner's key: refused.
6. Solo: anyone but the lone partner solo-approving in their name: refused.
7. `SET ROLE` / `RESET ROLE` around the statement changes nothing.
8. A second enrolment for an enrolled user: refused. A change without the old key: refused. The app's login deleting
   or updating a key row (the reset-then-enrol chain): refused.
8a. A new user made an owner of a paired workspace by raw SQL, enrolled, approving: refused at the `Membership` write.
   Removing the partner and adding another: refused. A third owner before pairing in a workspace with a wedding: refused.
8b. A temporary table or a changed `search_path` around any guarded statement changes nothing (step 0's test, kept).
9. Enforce leg only: the app's login cannot read or write the key table, replace a function, create a function in
   `public`, or disable a trigger.
10. The key does not leak to the next transaction on the same pooled connection (S4a's method).

Legitimate paths that must still pass: two keys through the real actions; solo; decline, withdraw, expiry by the
sweep and by cron; a re-proposal; approval after the proposer left the workspace; an operator reset followed by a
fresh enrolment and an approval; a second partner joining by invite and by SSO (the pairing itself); `seed:couple`;
`destroyOrg`; every existing consent test.

Existing tests that change, none weakened: `guard-d172.test.ts`'s `forged()` helper builds its approved-but-never-
executed requests with both partners' keys instead of none; its test "NOT closed, recorded in D-190" becomes the
attack tests above; the template harness row in `tests/fixtures/app.ts:27-28` proposes from a non-member id and has
to propose as an enrolled owner, inside a transaction (`seedApp` runs on `dbSystem` outside one today; INV-29 calls
it too; D-190 named this). The trigger fires for the owner role as well, so every test that creates a
`ConsentRequest` row directly needs the same care. The reviewer counted them: `two-key.test.ts:199,256`,
`solo.test.ts:139,156,161,195`, `secrecy-db.test.ts:400`, `guard-used-request.test.ts:161`.

### CI

- `ci (enforce)` becomes a required leg for Knotwork. It creates `app_rw` and grants on schema `public` only
  (`ci.yml:57-65`), which is why the key table lives in its own schema: neither that step nor `db-setup.ts`'s
  `grantApp` can hand it to the app's login by accident.
- "Migrations match the schema" (`prisma migrate diff --exit-code`) must stay green with a table outside `public`.
  Expected, not yet proven: step 2's PR proves it or moves the table.
- `structure.test.ts` gains: the new migration has no `CREATE OR REPLACE` or `DROP`; only `consent/store.ts` sets
  `knotwork.actor_key`; nothing in `src/` names the private schema.

---

## 7. Questions for Shane, one at a time

**1. Which mechanism?**
(a) D: a key per partner, checked by a database function. (b) C: a real login per partner on its own connection.
(c) B1: the app signs, the database verifies.
**Recommendation: (a).** It closes what (b) closes at a fraction of the cost and with no host limits; (c) leaves the
forged-session route. Choose (b) only if "a real Postgres login" matters in itself (for example, for database logs
that name the person).

**2. What counts as closed?**
(a) Raw SQL on the app's login (T2, T3), with the owner URL, the host console and a fully controlled server recorded
as out of reach of any trigger. (b) Also take the owner URL out of the running app (a template change to `asSystem`).
**Recommendation: (a) now**, (b) as a template item later.

**3. Where does a partner's key live?**
(a) Random, in a cookie on their device, shown once so it can be typed on another device. (b) A phrase they choose
and type at each approval. (c) A passkey (option E).
**Recommendation: (a).** A chosen phrase can be guessed by exactly the attacker this is for, and the database cannot
count failed guesses (a refused statement rolls its own count back).

**4. A lost key?**
(a) Only the operator resets a key (Shane, as the owner role, after hearing from the partner out of band).
(b) The other partner resets it with their own key. (c) Signing in is enough.
**Recommendation: (a).** With (b), raw SQL resets the other partner's key, enrols a new one in their name and
approves; with (c), a forged session does the same. Either reopens finding 1. (a) costs a wait for the operator.

**5. Enforce mode becomes mandatory for Knotwork, and its CI leg is switched on?**
(a) Yes: set the repo variable `RLS_ENFORCE=1` (Shane's action; it is a repository setting) as step 1. (b) Leave RLS
optional.
**Recommendation: (a).** With RLS off the app is the owner role and no option here binds it.

**6. The owner set.**
An owner may make anyone an owner (`mayAssign`, `src/core/authz/permissions.ts:20-21`), raw SQL can insert a `User`
and a `Membership` row, and any owner who is not the proposer may approve. I found no rule that caps a workspace at
two partners. One person with a made-up second account holds both keys, honestly proven, and the same works through
the app's own pages with a second email address.
(a) Leave it. (b) Freeze it: at most two owners in a workspace with a wedding, none added once paired; replacing a
partner is an operator act. (c) After pairing, a new owner is a designated action.
**Recommendation: (b), inside this change, not after it.** Without it the trusted identity proves only that *an*
owner approved, and one partner can make owners. (c) cannot work: the request to add an owner would need the very
partner who is being replaced. Still open after (b), by nature: who the second partner *is* was the first partner's
choice at pairing. And one owner can still delete the whole workspace alone (`destroyOrg`,
`src/app/o/[org]/settings/danger/actions.ts:11`): template behaviour, not finding 1, named here so it is not a
surprise.

**7. The shared demo couple.**
A demo account is shared by every `/demo` visitor (`src/core/auth/session.ts:103-111`).
(a) The seed enrols public demo keys and the demo sets the cookie, as the demo TOTP seed is public today. (b) Demo
workspaces are exempt from the guard.
**Recommendation: (a).** No exemption exists for a forger to aim at.

---

## Proposed D-rows (add once #9 merges)

In `docs/knotwork/decisions.md`'s shape. Numbered from D-200. Wording assumes the recommendations; adjust to the
answers.

| # | Date | Question | Options | Decision | Reversal |
|---|---|---|---|---|---|
| D-200 | (on build) | **Owner decision (Shane, 2026-11-28): a database identity per person before any real couple; closes D-190's open half.** How the database learns who is acting | (A) role per person by `SET ROLE` from the pooled login; (B) an identity the app signs; (C) a login per partner on its own connection; (D) a key per partner checked by a database function | **(D)** behind `knotwork_actor()`. (A) is refused: `SET ROLE` and `RESET ROLE` are open to the same raw SQL. (B) is refused: the app's login can insert a `Session` row, so the app would sign for a forger. (C) closes the same as (D) and stays possible behind the same function | a new body for `knotwork_actor()`; or drop the trigger in a new migration |
| D-201 | (on build) | What "closed" means for finding 1 | everything; raw SQL on the app's login | **For a partner who enrolled their own key, raw SQL on the app's login (`app_rw`) can neither approve as them, nor invent a proposer, nor invent a decider.** Not closed, by any trigger: the owner URL, the host's console, a fully controlled server; and a key enrolled in a partner's name by whoever reached the app's login first (latched, logged, shown to the partner, fixed only by the operator) | none |
| D-202 | (on build) | RLS enforce mode for Knotwork | optional (the template's default); required | **Required**, and `ci (enforce)` runs on every PR (repo variable `RLS_ENFORCE=1`). With RLS off the app is the owner role, which no trigger binds | unset the variable |
| D-203 | (on build) | Where the key and its check value live | a `public` table; a private schema | **Schema `knotwork_private`**, no rights for the app's login: the grant steps in `ci.yml` and `db-setup.ts` cover `public` only. The table holds SHA-256 of a random 256-bit key (as INV-07). The key lives in an `httpOnly` `__Host-` cookie and is shown once | move the table in a new migration |
| D-204 | (on build) | The guard | replace `knotwork_request_guard`; a new trigger | **A new trigger after the existing three (D-196's convention).** Insert: the proven actor is the proposer and an owner. Approve: the proven actor is the decider. Solo (D-33): the proven actor is the proposer. Decline, withdraw: the proven actor is the decider, the proposer. Expiry: unchecked. The proposer is checked at insert only, so a request outlives its proposer's membership as today (D-190) | drop the trigger in a new migration |
| D-205 | (on build) | Enrolment, change, loss | signing in is always enough; the other partner resets; operator only | **Latched, operator reset only.** Enrol once; change with the old key; no reset function exists for the app's login (reset-then-enrol would be a forged approval in three statements). Each enrolment and change writes an audit line | add a reset function in a new migration |
| D-206 | (on build) | Tests | — | The ten attacks and the legitimate paths in the plan; each attack fails with its trigger off; `forged()` in `guard-d172.test.ts` uses both keys; the "NOT closed" test becomes the attack tests; the harness row proposes as an enrolled owner. Nothing deleted, skipped or weakened | none |
| D-207 | (on build) | The owner set: one partner could make a third owner (raw SQL, or the app's own member pages) and approve as it | leave; freeze at pairing; make a new owner a designated action | **Frozen at pairing**: a workspace with a wedding has at most two owners, and once paired no membership becomes an owner (triggers on `Membership` and on `Wedding` insert, from a clone migration, as D-56). Replacing a partner is an operator act | drop the triggers in a new migration |
| D-208 | (on build) | **Found by the plan's review: a temporary table of the same name answered every guard's question** (no guard function set `search_path`; reproduced on a scratch Postgres 16) | qualify every table name in new copies of the functions; set `search_path` on the functions | **`ALTER FUNCTION ... SET search_path = pg_catalog, public, pg_temp`** on every Knotwork guard function, in its own migration, first; every later function is created with it. No function body and no applied migration is edited. Test: a temporary `"ConsentRequest"`, `"Membership"`, `"Wedding"` or `"Org"` changes no guard's answer | `ALTER FUNCTION ... RESET search_path` |

---

## Not verified

- The value of the repo variable `RLS_ENFORCE` (the Actions API is closed to this session). Inferred from the check
  runs on `1c4e4c0`, which have no `ci (enforce)`; the reviewer could not repeat that lookup.
- Fact 4 on Knotwork's own schema. It was reproduced on a scratch Postgres 16 with a guard of the same shape (an
  unqualified `EXISTS` in a plpgsql trigger function, a non-owner role), not by running Knotwork's migrations.
- That no template test needs three owners in an org that has a wedding (the owner-set freeze).
- The RDS Proxy sentence about `set_config(name, value, true)`, and the exact PostgREST wording quoted in option B
  (the reviewer found it in the v10 page; the stable page words it differently). Supabase discussion 19695 supports
  only the name of the setting. Neon's 60-bit password rule and its "SET/RESET" wording were read on the pages as
  fetched here and not confirmed by the reviewer.
- Why `ci (off)` shows `failure` on `main` at `1c4e4c0` (PR #9's head, which contains that merge, is green). Logs not
  readable from here.
- That `prisma migrate diff` ignores a table outside `public` (section 6, CI).
- That query parameters stay out of `pg_stat_activity` and of each host's default logs (option D, risks).
- On Neon: whether a SQL-made role can be given `CREATEROLE` for option C, and whether `pg_session_jwt` can be used
  from a pooled Prisma connection. On Supabase: whether `postgres` may create roles with `CREATEROLE`; the SQL body
  of `auth.uid()` (the docs describe the setting it reads; the source was not read).
- PgBouncer's pages do not mention `SET LOCAL` by name; that it is safe in transaction mode rests on the Postgres
  docs and on this repo's spike S4a.
- Nothing in the repository was run. Every code claim was read in the files cited; every host claim is from the linked page as
  fetched on 2026-11-28.

---

## Review (one fresh agent, 2026-11-28) and what changed

One independent agent (`claude -p`, given the repository, this file and the goal; it wrote nothing) read the first
draft. Verdict: "do not adopt as written". Four must-fixes, all taken:

1. **The partner-reset flow reopened finding 1** (reset, enrol in their name, approve). Held. Changed: no reset the
   app's login can call; operator only (option D, section 5, question 4, D-205).
2. **A made-up third owner could be the decider**, and the draft filed it as "not finding 1, later". Held. Changed:
   the owner set freezes at pairing, inside this change (option D, section 5, question 6, D-201, D-207).
3. **The new trigger could be shadowed through `search_path`.** Held in substance, with a different mechanism: tested
   on a scratch Postgres 16, a temporary *function* does not shadow, but a temporary *table* does, and that fools
   every guard already on `main`. Changed: fact 4, step 0, test 8b, D-208; every function pins `search_path`.
4. **"First enrolment trusts the web session once" was wrong**: enrol is callable by the app's login for any user id.
   Held. Changed: the gap is stated exactly, and "closed" now reads "for a partner who enrolled their own key".

Should-fixes taken: where the functions live and why the migration cannot grant by role name; the fuller list of
tests that change; the key is set inside `propose()` and `decide()`, with the callers listed; the RDS Proxy,
PostgREST, Supabase and Neon citations hedged; the CI observations marked as not repeated by the reviewer. Nits
taken: `ci.yml` line numbers, the T2 note, the HMAC variant's cost, `destroyOrg`. One nit not taken:
`ConsentRequest_two_key_check` is at line 410 of the phase 1 migration, as written.
