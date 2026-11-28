# Knotwork — plan: a Postgres login per partner, unlocked by a passkey (closing D-172 finding 1)

First written 2026-11-28; **revised the same day after Shane's decisions** (below). **A plan only: no code, migration,
schema, test or dependency changes are in this PR.** Knotwork is not deployed and holds synthetic data only. Read
against `main` at `4db2ec7` (PR #9, `fix/d172-guards`, is merged). Every code claim cites a file on that commit; every
host and browser claim cites the page it was read on, as fetched on 2026-11-28.

## Decisions (Shane, Saturday 2026-11-28, all final)

| | Question | Decided |
|---|---|---|
| Host | Where the database lives | **Neon.** Its pooler is PgBouncer in transaction mode; 500 roles per branch |
| Q1 | Mechanism | **Option C: a real Postgres login per partner.** Option D (a key per partner checked by `knotwork_actor()`), which the first draft recommended, is now the rejected alternative |
| Q2 | What counts as closed | Raw SQL on the app's login cannot forge an approval, **and** the owner (migration) URL is not present in the running app. The second half may be a later, separate step; it is in this plan (section 6) |
| Q3 | Where a partner's credential lives | **A passkey (WebAuthn).** The server never holds a partner's database password in usable form |
| Q4 | A lost passkey | **Operator-only reset** |
| Q5 | RLS | **Enforce mode is mandatory; the CI enforce leg is on** (Shane set the repo variable `RLS_ENFORCE=1`; what CI shows is under "Not verified") |
| Q6 | The owner set | **Frozen at two once paired, inside this change.** Replacing a partner is an operator act |
| Q7 | The demo couple | **Seeded public demo logins**, running through the same guards |

**In one paragraph.** Each partner gets a Postgres login (`kwp_…`). Its password is a random 256-bit value made in the
partner's browser and kept only as a blob encrypted under a key that the partner's passkey derives (the WebAuthn PRF
extension). To propose or decide, the browser unlocks the password with the passkey and **connects to Neon itself**,
as the partner, to write one row: a signature naming the request and a digest of its content. The app's own login then
writes the request as it does today, and a new trigger refuses the write unless the matching signature is there.
The app's login cannot write signatures, cannot log in as a partner, and cannot create or alter roles. The credential
that can (it has `CREATEROLE`) is held by the operator and is never in the running app; neither, after section 6, is
the owner URL.

**Does C plus passkeys close finding 1 under Q2's definition? Yes for raw SQL on the app's logins; conditionally
overall.** The conditions and what stays open are stated exactly in section 3, "What is closed, and what is not".
The short form: it does **not** stop the server from acting as a partner in every case. A server that is fully
controlled (or a script injected into a partner's page) can misuse a partner's passkey **at the moment that partner
uses it on that page**, and can keep the unlocked password afterwards. It can never act for a partner who has not used
their passkey on a compromised page since their last reset, and nothing stored on the server, in the database or in
the environment is enough to act as anyone.

---

## 1. The current state (verified on `main` at `4db2ec7`)

### How the app connects, and which roles exist

- Two Prisma clients over `pg` pools. `db` uses `DATABASE_URL` (`src/core/db/index.ts:19`); `dbSystem` uses
  `DATABASE_URL_SYSTEM` and is the same client as `db` when that is unset (`src/core/db/system.ts:11`).
- Two database roles, made by `scripts/db-setup.ts`: the **owner** (migrates, owns every table, bypasses RLS) and
  **`<name>_app_rw`** (`LOGIN NOBYPASSRLS NOSUPERUSER`, line 27), granted `SELECT, INSERT, UPDATE, DELETE` on every
  table in `public` (lines 38 to 42).
- **RLS is off by default.** `db-setup.ts` writes `DATABASE_URL` as the owner and leaves `RLS_MODE=enforce` commented
  out (lines 71 to 78). In enforce mode `DATABASE_URL` is `app_rw` and the owner is used through `asSystem`
  (`src/core/db/rls.ts:27-29`), from the closed list in `src/core/db/cross-org.ts` (17 files today: sign-in, invites,
  share links, cron, exports, SSO, API keys, and Knotwork's three public-link files).
- **The owner URL is in the running app today.** In enforce mode `DATABASE_URL_SYSTEM` is the owner
  (`src/core/env.ts:10-12`), and the README tells a deployer to put the owner in Vercel twice: `DATABASE_URL_SYSTEM`
  through the pooler and `DIRECT_URL` without it (`README.md:63-64`). Nothing at run time reads `DIRECT_URL`
  (`prisma.config.ts:13` reads it for the CLI only), and the build does not migrate (`package.json` `build` is
  `next build`; `vercel.json` has no migrate step).
- There is **no role per person**, no passkey or WebAuthn code anywhere in `src/`, `tests/` or `e2e/`, and no
  migration reads `current_user` or `session_user`.

### How RLS learns who is asking today

It learns *which workspace*, never *who*. `withOrg` opens a transaction and runs
`set_config('app.org_id', <orgId>, true)` (`src/core/db/rls.ts:15-21`); every policy compares `"orgId"` with
`current_setting('app.org_id', true)` (`prisma/migrations/20261105000000_rls_policies/migration.sql:11`; the
expression is on 581 lines of the policy migrations). The person exists only in the app: the session cookie is hashed
and looked up in `Session` (`src/core/auth/session.ts:73-87`), `requireOrg` reads the membership
(`src/core/authz/guards.ts:24-45`), and `ctx.userId` is written into rows as plain data
(`src/lib/knotwork/consent/store.ts:28` and `:78`).

### Why a trigger cannot trust any of that

1. **One login.** `current_user` and `session_user` are the same for both partners.
2. **A session setting is a claim, not a proof.** Postgres accepts any two-part setting name from any role
   ([custom options](https://www.postgresql.org/docs/current/runtime-config-custom.html)). D-190 rejected the idea
   for that reason.
3. **The ids are just columns.** `ConsentRequest.proposerId` and `deciderId` are UUIDs the writer supplies. The checks
   that exist compare them with each other and with `Membership`: `ConsentRequest_two_key_check`
   (`20261123000001_knotwork_phase1/migration.sql:410`), `ConsentRequest_insert_guard` and the solo rule in
   `knotwork_request_guard` (`20261124000000_knotwork_solo/migration.sql`), and `ConsentRequest_partner_guard`
   (`20261128000010_knotwork_guard_d172/migration.sql`, the last function in the file: the decider of an approval is
   an owner of that workspace). None can tell *who typed the statement*. That migration's own comment says so:
   "the database has no identity it can trust for 'who is asking'".
4. **The designated-field guards inherit the gap.** `knotwork_require_approved` and the vendor, wedding, expense and
   mode guards ask "is there an approved request?". A forged approval satisfies every one. The tests use this: the
   `forged()` helper (`tests/knotwork/guard-d172.test.ts:58`) builds approved requests with raw SQL, and the test at
   line 355 pins the gap open ("NOT closed, recorded in D-190").

### Four more facts every design must face

- **The app's login can forge a web session.** `Session` has no `orgId`, so no RLS policy; `app_rw` holds `INSERT` on
  it; the app inserts sessions as `db` (`src/core/auth/session.ts:60-65`). So a proof derived from the web session is
  one more line in the forger's script.
- **The owner role can never be bound by a trigger.** A table's owner can disable its triggers; the tests do
  (`guard-d172.test.ts:384`, `guard-used-request.test.ts:191`, `solo.test.ts:171`). So the app must not *be* the
  owner (Q5) and must not *hold* the owner URL (Q2).
- **What a request's guard already pins.** After insert, `kind`, `payload`, `proposerId`, `orgId` and `expiresAt`
  cannot change (`knotwork_request_guard`). **`summary` can**: it is the sentence a partner reads before approving,
  and nothing protects it. The design below signs it.
- **A temporary table fools every guard today** (no Knotwork guard function sets `search_path`; only the template's
  `org_event_assign_seq` does, `20261108000000_org_events/migration.sql:28`). Reproduced earlier on a scratch
  Postgres 16 with a guard of the same shape. **This is step 0 and is being fixed now in its own PR (#11, branch
  `fix/guard-search-path`, a draft; it records the fix as D-199). This plan does not repeat it.** It only requires
  what that PR's own test will enforce: every new function here is created with
  `SET search_path = pg_catalog, public, pg_temp`, and so names the `knotwork_private` tables schema-qualified.

### Who the attacker is

| | Actor | Today |
|---|---|---|
| T1 | A partner using the app's pages | Closed by the app (`transition`, `src/lib/knotwork/consent/machine.ts:55`) |
| T2 | SQL injected through an app bug, running on one of the app's logins | Open |
| T3 | Someone holding the app's database URLs (a leaked environment) | Open, and today that leak includes the owner URL |
| T4 | The operator: the owner URL, the role-creating credential, the Neon console and API key; and Neon's staff | Open, and stays open in every option |
| T5 | Full control of the running server (its code and its environment), or a script injected into a partner's page | Open; narrowed below, never closed |

Finding 1, as D-172 and D-190 record it, is T2 and T3. Q2 adds: T3 must not include the owner URL.

---

## 2. The options, kept for the record

**A. A role per person by `SET ROLE` from the pooled login.** Closes nothing: `SET ROLE` needs only that the session
user holds the role, and `RESET ROLE` is open to anyone
([SET ROLE](https://www.postgresql.org/docs/current/sql-set-role.html)); raw SQL on the app's login switches roles
exactly as the app would. It is D-190's rejected option with a role name in place of a setting.

**B. An identity the app (B1) or an outside provider (B2) signs, verified in the database.** B1 signs for whoever the
web session says, and the app's login can forge a web session. B2 replaces the template's sign-in with a vendor.
(Supabase's `auth.uid()` reads a setting PostgREST fills; Neon's docs say of the same setting that it "can be modified
by any database user", [pg_session_jwt](https://neon.com/docs/extensions/pg_session_jwt).)

**C. A separate Postgres login per partner (chosen).** Postgres itself checks the password; `session_user` cannot be
changed without superuser
([SET SESSION AUTHORIZATION](https://www.postgresql.org/docs/current/sql-set-session-authorization.html)); the
password check value sits in the role catalog, which the app's logins cannot read or write. Costs: a role-creating
credential must exist somewhere; role lifecycle; host limits; and, with Q3, the partner's connection has to start in
the browser (section 3).

**D. A key per partner, checked by a database function (rejected alternative).** A random key in a cookie; its SHA-256
in a table the app's login cannot touch; `knotwork_actor()` compares. Closes the same raw-SQL attacks as C with no
roles, no role-creating credential and no host limits.
**Why D was not chosen:** the decision (Q1, Q3) is for a real Postgres login per partner, authenticated by Postgres
itself, with the credential held by a passkey; D's key would sit in a cookie that the server reads on every approval,
which Q3 rules out. D remains the fallback if a Neon limit below turns out to block C (section 8, question 4).

**E. A passkey signature verified inside the database.** Would need signature verification inside Postgres (an
extension). The chosen design gets E's property (a per-request signature the server cannot make) by using C's
password check as the verification step, with no extension.

| | A | B1 | C + passkey (chosen) | D |
|---|---|---|---|---|
| T2 / T3 raw SQL approves as the other partner, or invents a proposer | open | open through a forged session | **closed** | **closed** |
| The server holds something that lets it act as a partner | yes | yes (the signing secret) | **no** (see T5) | yes, on every approval (the cookie) |
| Needs a role-creating credential | yes | no | yes, operator-held | no |
| Host limits | role count | none | 500 roles a branch | none |
| T4 the operator, the host | open | open | open | open |
| T5 the whole server | open | open | only while a partner is using their passkey | open |

---

## 3. The design: C on Neon, with passkeys

### The roles

| Role | Made by | Attributes | Used by | Where its credential lives |
|---|---|---|---|---|
| owner (Neon's console role, a `neon_superuser`) | Neon console | `CREATEROLE`, `CREATEDB`, `BYPASSRLS` ([roles](https://neon.com/docs/manage/roles)) | migrations only | the operator's password manager and one CI secret (section 6). **Not in the running app** |
| `knotwork_provisioner` | owner, in SQL | `LOGIN CREATEROLE`, no table rights except the two enrolment tables | the operator's scripts: create, reset, drop partner roles | the operator's password manager. **Never in the running app, never in CI** |
| `app_rw` | owner, in SQL (as README today) | `LOGIN NOBYPASSRLS` | the app, `DATABASE_URL` | the app's environment |
| `app_sys` (new, section 6) | owner, in SQL | `LOGIN BYPASSRLS`, **owns nothing** | the app, `DATABASE_URL_SYSTEM` (`asSystem`) | the app's environment |
| `knotwork_partner` | a migration | `NOLOGIN` group; `EXECUTE` on `knotwork_sign` only. The role setup script grants it to `knotwork_provisioner` `WITH ADMIN OPTION`, which adding members needs | nobody directly | none |
| `kwp_<32 hex of the user id>` | `knotwork_provisioner` | `LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 2 IN ROLE knotwork_partner` | one partner's browser | **nowhere in usable form**: wrapped under the partner's passkey |

**The role-creating credential is the main risk, so it is the operator's and nobody else's.** A `CREATEROLE` role
"can alter and drop roles which have been granted to the `CREATEROLE` user with the `ADMIN` option", which is every
role it created, and "altering a role includes ... changing passwords"
([role attributes](https://www.postgresql.org/docs/17/role-attributes.html)). Whoever holds it can set a partner's
password and sign as them. If it sat in the app's environment, a leaked environment (T3) would reopen finding 1. So
partner roles are created, reset and dropped only by scripts the operator runs by hand, from the operator's machine.
The cost is that **enrolment waits for the operator** (question 1).

**Does Neon let a SQL-created role hold `CREATEROLE`? Not confirmed.** Neon's docs list `CREATEROLE` as an attribute of
`neon_superuser`, and say roles created with SQL "are not granted membership in the neon_superuser role" and "are only
granted the basic public schema privileges granted to newly created roles in a standalone Postgres installation"
([roles](https://neon.com/docs/manage/roles)); neither that page nor
[database access](https://neon.com/docs/manage/database-access) says whether `CREATE ROLE … CREATEROLE` is accepted
from the owner. Stock Postgres allows it (any `CREATEROLE` role may run `CREATE ROLE`, and `CREATEROLE` is not among the
attributes the documentation restricts: `SUPERUSER`, `REPLICATION`, `BYPASSRLS`, `CREATEDB`). It needs a spike on a Neon branch (section 7, N1). **If Neon refuses,
the operator's scripts use the owner role instead.** That changes nothing about who holds the power (the operator
holds both), only that the owner URL is used more often. Two things must never be used for partner roles: the Neon
console and the Neon API, because roles made there join `neon_superuser` (`BYPASSRLS`, `CREATEROLE`).

### Why the partner's connection starts in the browser

Q3: the server never holds a partner's password in usable form. Three ways a consent statement could run as the
partner's role:

1. **The browser connects to Neon itself (chosen).** Neon's serverless driver "sends each query as an HTTP fetch
   request" with the role and password in the connection string, and runs in a browser, where it prints "WARNING:
   Running SQL directly from the browser can have security implications" until `disableWarningInBrowsers` is set
   ([serverless driver](https://neon.com/docs/serverless/serverless-driver)). The password goes from the browser to
   Neon over TLS and never passes through Knotwork's server.
2. *The browser sends the password to the server, which opens the connection.* The password is then in the server's
   memory on every approval. Ruled out by Q3.
3. *The server relays Postgres's SCRAM handshake to the browser.* The server never sees the password but ends up
   holding a logged-in partner connection, and it needs a hand-written Postgres client. Not chosen.

Because of (1), the whole consent transaction cannot run as the partner: `decide` writes the approval and runs
`executeApproved` in one transaction, in TypeScript, through Prisma (`src/lib/knotwork/consent/store.ts:76-80`: "One
UPDATE writes the second key and the execution time; the action follows in this same transaction"). So **the partner's
connection does one small thing, and the app's transaction stays where it is:**

- The partner's connection calls one function, `knotwork_sign(action, request_id, digest)`. It writes a **signature
  row**. Nothing else is granted to a partner role: no table, no other function.
- The app's transaction (as `app_rw`, unchanged in shape) writes the `ConsentRequest` row. A new trigger refuses the
  write unless the matching signature row exists, is fresh and unused, and consumes it.

This is option C (a real login per partner, identified by Postgres) used as a signing step.

### How the identity reaches the trigger

- `knotwork_sign` is `SECURITY DEFINER` and reads **`session_user`**, never `current_user`: inside a definer function
  `current_user` is the function's owner, and `SET ROLE` moves `current_user` but not `session_user`. It looks the
  role name up in `knotwork_private.partner_role` (role name, user id, **workspace id**, state), a table only the
  owner and `knotwork_provisioner` can write. An unknown, retired or not-yet-active role is refused. So are `app_rw`,
  `app_sys` and the owner: they map to no user.
- **A login is good for the workspaces the operator enrolled it for, and no other.** The signature records the
  workspace, and the trigger requires it to equal the request's `orgId`. Without this, raw SQL could swap the
  membership of a workspace that has never been paired (delete its one owner, insert another user as owner) and let
  any enrolled login, the public demo ones included, act there alone in solo mode. `Membership` is the app's to
  write; the mapping is not.
- The signature row (`knotwork_private.consent_signature`: request id, action, user id, workspace id, digest, signed
  at, used at; one row per request, action and user, so one partner cannot occupy another's slot) is written only by
  that function, which refuses a user who already has more than a small number of unused rows. The app's logins have
  no rights on the schema.
- **Both new functions that touch `knotwork_private` are `SECURITY DEFINER`, owned by the owner, with the pinned
  `search_path`:** `knotwork_sign`, and the trigger function behind `ConsentRequest_proven_actor` (a plain trigger
  function runs with the writer's rights, and `app_rw` has none on that schema, so every insert would fail). A
  structure test holds that every function in the new migrations carries the pin, and that these two are definer.
- Through Neon's pooler nothing changes: PgBouncer "creates a separate pool for each combination of database user and
  database name" ([pooling](https://neon.com/docs/connect/connection-pooling)), so a partner's statement runs on a
  server connection logged in as that partner. The call is one statement, so transaction mode's limits (no `SET`, no
  session state) do not touch it. **Whether `session_user` over Neon's HTTP endpoint is the partner role is expected
  and not yet proven** (spike N3).
- **The digest** is computed by one SQL function, `knotwork_request_digest(id, orgId, kind, proposerId, payload,
  summary)` (SHA-256 over a fixed text form; `sha256` is built into Postgres). The server calls it to tell the browser
  what to sign; the trigger calls it again on the row being written. It covers `summary`, which nothing protects
  today (section 1).

### How the guards change

All new rules are **a new trigger in a new migration**, named to fire after the existing three
(`ConsentRequest_guard`, `ConsentRequest_insert_guard`, `ConsentRequest_partner_guard`), for example
`ConsentRequest_proven_actor`, with no `CREATE OR REPLACE` of an old function (D-196). Every old refusal still comes
first, with its old sentence. Every new function is created with the pinned `search_path` step 0 sets.

| Moment | Today | Added rule |
|---|---|---|
| **Insert (the proposer)** | born pending and unsigned; `proposerId` unchecked (D-190) | an unused `propose` signature for `NEW.id`, made by `NEW."proposerId"`, at most 10 minutes old, whose digest equals the digest of the new row; and the proposer is an owner of `NEW."orgId"` now. Closes "inventing a proposer" |
| **Approve, two keys (the decider)** | decider is not the proposer (`ConsentRequest_two_key_check`); decider is an owner (`ConsentRequest_partner_guard`) | an unused, fresh `approve` signature for this request, made by `NEW."deciderId"`, digest equal to the row's; and the proposer's `propose` signature for the same digest exists. Closes "approve as the other partner" |
| **Approve, solo (D-33)** | one owner, who is the proposer, never paired (`knotwork_request_guard`) | the `propose` signature of this request by `NEW."proposerId"` exists with the row's digest. In solo mode asking is deciding, so one passkey touch covers both; nobody else can ask in their name |
| **Decline** | decider recorded | a `decline` signature by `NEW."deciderId"` |
| **Withdraw** | none | a `withdraw` signature by `OLD."proposerId"` |
| **Expire** | none | none: the lazy sweep and cron have no person (`expireDue`, `consent/store.ts:47-54`), and expiry executes nothing |

- **The proposer is checked at insert only**, so a request outlives its proposer's membership as today (D-190).
- **The designated-field guards do not change.** They keep asking for an approved request. Once an approval cannot be
  forged, that question means what it was meant to.
- **Solo mode (D-33) and the pairing latch (D-56) do not change.** A solo partner needs an enrolled passkey like
  anyone else.
- **`summary` is pinned too**: the new trigger refuses any change to it after insert. `expiresAt` is set by the
  server at commit and is not in the digest; it is pinned after insert already.
- **Pending requests made before this trigger exists have no proposer signature and can never be approved.** There
  is no deployed database; local ones are re-seeded.
- **A signature alone changes nothing.** It is a row no guard reads until the app's write arrives. A signature that
  is never used lapses after 10 minutes. If the app's transaction rolls back (execution refused), the consumption
  rolls back with it and the same signature can be retried inside its window, for the same request and content only.
- **The owner set (Q6; proposed row D-207).** New triggers on `Membership` and on `Wedding` insert: a workspace
  that has a wedding never has more than two owners; once `pairedAt` is set, no membership is inserted as, or changed
  to, `owner`, **and an owner row's `userId` and `orgId` never change** (re-pointing an existing owner row at
  another account keeps the role and would otherwise pass; today's latch fires only on insert or a change of `role`,
  `20261124000004_knotwork_pairing_latch/migration.sql:29`). Removal is still allowed (a request then has nobody to approve it). They take the same
  `Org` row lock as `Membership_pairing_latch` (`20261124000004_knotwork_pairing_latch/migration.sql`). Without this,
  one partner makes a third owner (`mayAssign`, `src/core/authz/permissions.ts:20-21`; raw SQL can insert a `User` and
  a `Membership`) and approves as it. With the operator enrolling partners that route is also blocked at enrolment,
  but the freeze is the rule that does not depend on the operator noticing.

### What changes in the app (Knotwork-owned files only)

- **Proposing becomes two calls around one passkey touch.** (1) *Prepare*: the action validates as today, picks the
  request id, and returns id, digest and summary; it writes nothing. (2) The browser asks for the passkey and calls
  `knotwork_sign('propose', id, digest)` on Neon. (3) *Commit*: today's action, with the id. If anything changed in
  between, the digests differ and the trigger refuses. `ConsentRequest.id` has no database default
  (`20261123000001_knotwork_phase1/migration.sql:208-209`), so the app already supplies it.
- **Deciding** is the same with no prepare step: the page shows the request and its digest; approve, decline or
  withdraw asks for the passkey, signs, then calls today's action.
- The eight `propose` call sites (`src/app/o/[org]/wedding/actions.ts:239,285,356,369,470`,
  `src/app/o/[org]/wedding/guests/actions.ts:181`, `src/app/o/[org]/wedding/life/actions.ts:30`, `src/lib/knotwork/contingency/store.ts:124`) and the three `decide` sites
  (`wedding/actions.ts:436,445,454`) gain the step. `propose()` and `decide()` themselves change only by taking the id.
- **Every designated action now needs a passkey touch.** That is the visible cost of Q3.
- **The page needs to reach Neon.** The app sends one header today, `Content-Security-Policy: frame-ancestors 'none'`
  (`next.config.ts:7`), so nothing blocks the connection now; a `connect-src` rule naming only the app and the Neon
  host should be added with this work, because an injected script is the main thing left (T5).
- **No new environment key is needed**: the Neon host and database name come from `DATABASE_URL` on the server and are
  given to the page. (A new key would mean editing template-owned `src/core/env.ts` and `.env.example`, INV-14.)
- New Prisma models, both without `orgId`, so both are named in `GLOBAL_MODELS` (`tests/fixtures/app.ts:98`):
  `PartnerCredential` (user, credential id, wrapped password, label) and `PartnerEnrolment` (user, the password
  sealed to the operator's public key, state). The app's login may write both; neither holds anything usable
  (below).

### Connections, latency, the cap

- **Connections.** The app's pools do not change (8 for `db`, 2 for `dbSystem`, `src/core/db/index.ts:19`,
  `system.ts:11`). A signature is one HTTPS request from the browser to Neon, which uses one server connection as
  that partner for one statement. Each partner role has `CONNECTION LIMIT 2`. All pools on a compute "draw from the
  same underlying `max_connections` limit" (112 on the smallest compute; the pooler accepts 10,000 clients)
  ([pooling](https://neon.com/docs/connect/connection-pooling)). Designated actions are a few a day per couple. How
  long Neon keeps an idle per-role connection open after an HTTP query is not documented on the pages read (spike N4).
- **Latency.** One extra browser round trip per designated action, plus a compute wake if the branch has scaled to
  zero. Nothing is added to any other request. The passkey prompt itself takes longer than the query. No number is
  claimed here; the spike measures it.
- **The cap.** "Neon enforces a limit of 500 roles per branch" ([roles](https://neon.com/docs/manage/roles)). The
  fixed roles take five (owner, provisioner, `app_rw`, `app_sys`, the group), the demo couple two, so about
  **245 couples a branch**. The enrolment script counts roles before creating one, warns from 400 and **refuses at
  490 with a plain message**; nothing else stops working at the cap, and existing couples are unaffected. Getting past
  it is question 4.

### Role naming and cleanup

- **Name:** `kwp_` plus the user id without dashes (36 bytes; Neon allows 63 and reserves `pg_…` and a short list of
  names, [roles](https://neon.com/docs/manage/roles)). One role per person, not per workspace. The mapping table,
  not the name, is what the function trusts.
- **Local and CI:** roles are shared by every database on a Postgres server (`scripts/db-setup.ts:10` says the same of
  `app_rw`), so a role made for the dev database can connect to the test database. It maps to no user there and is
  refused. Tests drop the roles they create.
- **When a workspace or an account is deleted** (`deleteOrg` and `deleteAccount`, `src/core/tenancy/delete.ts:13,25`),
  the app cannot drop a role and must not be able to. Signing ends at once without any cleanup: a request in a
  deleted workspace cannot exist, and a former owner fails the membership checks. The operator's `sweep` script
  lists mapping rows whose workspace or user is gone, drops those roles and removes the rows. Until it runs, such a
  role can still log in and do nothing, and still counts toward the 500. (No trigger retires a mapping when a
  membership row is deleted: the app's login can delete membership rows, and that must not be a way to lock a
  partner out for good.)
- **Branches:** a Neon child branch copies its parent's roles and passwords. Preview branches made from a branch that
  holds real partners carry their logins; the productionize note must say not to do that.

### What a partner's login can do besides sign

A partner holds a real database login, so the plan must say what that login reaches. It is granted nothing but
`EXECUTE` on `knotwork_sign`. Like every Postgres role it also has what `PUBLIC` has: it can connect, read the system
catalogs (table, function and role names, function source), and use CPU with its own queries. It cannot read or write
any Knotwork table (no grants; RLS would not help here, since a partner could set `app.org_id` itself, so there must
be no grants at all). It can create temporary tables, which is harmless once step 0 has pinned `search_path`.
Functions are executable by everyone by default, so the migration revokes `EXECUTE` from `PUBLIC` on
`knotwork_sign` and grants it to the group only. (The existing guard helpers stay as they are: they run with the
caller's rights, so a partner calling one reaches no table; and they cannot be revoked from `PUBLIC` without
breaking the app, because a migration cannot name the app's role, which is `<name>_app_rw` locally and `app_rw` in
CI.) Each partner role is created with a `statement_timeout` (a default its holder can override, so it limits
accidents, not abuse); a setting on the group would not reach its members.
**Accepted and recorded:** an enrolled partner, and anyone using the public demo logins (Q7), can run their own
read-only catalog queries against the database host.

### The passkey flow, end to end

**What PRF is.** The WebAuthn `prf` extension makes the authenticator compute a secret from a salt the site supplies,
bound to that one credential and that site's domain; Chrome's intent to ship describes it as "a pseudo-random
function (i.e. HMAC), stored on the security key, to be evaluated when getting a credential"
([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI)). The secret never leaves the
browser. Knotwork uses it as a key-wrapping key: HKDF, then AES-GCM around the database password.

**Enrolment (once per partner).**
1. The partner is signed in as today (the template's own sign-in and TOTP are unchanged; the passkey is not a sign-in
   method here). On the enrolment page the browser creates a passkey with the `prf` extension, user verification
   required. If the authenticator returns no PRF result at creation (some do not), the browser asks once more with
   `get()`. **No PRF result: enrolment stops** (below).
2. The browser makes the database password `K` (32 random bytes, far above Neon's "minimum entropy of 60 bits"). It
   stores `K` wrapped under the PRF key (`PartnerCredential`) and `K` sealed to the **operator's public key**
   (`PartnerEnrolment`), and shows the partner a **fingerprint** of `K` (16 characters of its hash). The server
   receives ciphertext only.
3. **Approval by the operator (Q4's counterpart).** The partner tells the operator the fingerprint out of band. The
   operator runs the enrolment script on their own machine: it opens the sealed `K` with the operator's private key,
   shows its fingerprint, and, if the operator confirms the match **and which workspace this person is a partner of**,
   runs `CREATE ROLE kwp_… LOGIN PASSWORD '<K>' …` as `knotwork_provisioner` and writes the mapping row for that
   workspace as `active`. (A person who is a partner in a second workspace gets a second mapping row, same login.) `K` exists on the operator's machine for that
   moment; the operator can reset any password anyway (T4), so this gives away nothing new. The operator's public
   key is a constant in the repository, not something the server sends at run time. The provisioner's own credential
   is rotated with `ALTER ROLE … PASSWORD`, never by re-creating the role, which would lose its admin rights over
   every partner role.
   Why sealed and not hashed: Neon says "Passwords must be supplied in plain text" and "Hashed passwords are not
   supported" ([roles](https://neon.com/docs/manage/roles)), so the browser cannot hand over a SCRAM verifier, as
   stock Postgres would allow.
   Why the fingerprint: the app's login can write `PartnerEnrolment`, so a forger could file or replace an enrolment
   in a partner's name. The fingerprint is never stored, so the forger cannot match it.
4. The partner's next designated action unlocks `K` with the passkey and signs.

**Using it.** Passkey prompt, PRF result, unwrap `K` (AES-GCM fails loudly on a wrong key), one statement to Neon,
`K` dropped from memory. `K` is never written to browser storage.

**More than one device.**
- **Every further device is treated as a further authenticator.** A synced passkey (iCloud Keychain, Google Password
  Manager) is one credential on all of an account's devices and is meant to give the same PRF value everywhere, but
  the plan does not rely on that: the review cites Apple forum reports of synced or cross-device passkeys returning
  different values for the same salt (threads 764730 and 822523; not read in this session). If the value differs,
  the unwrap fails cleanly and the device is added like any other. Spike P1 checks it on real devices.
- A second authenticator has a different PRF value. While `K` is unlocked on the first, the partner
  registers the second in the same browser (a security key, or a phone over the cross-device QR flow); the browser
  wraps the same `K` under it and stores a second `PartnerCredential` row. One role, one password, several wrappings.
  No operator step.
- The app's login can delete or corrupt a wrapping. That locks a partner out (operator reset); it cannot produce a
  wrapping of the real `K`, so it cannot impersonate.

**Lost passkey, operator-only reset (Q4).** If every enrolled authenticator is gone, `K` is gone. The partner asks the
operator out of band. The operator's reset script drops the role, deletes the mapping, the wrappings and any unused
signatures, and writes an audit line. The partner then enrols again from step 1, with a new passkey, a new `K`, and a
new fingerprint check. There is no reset the app's logins, the other partner, or a signed-in session can perform:
none of them can alter a role.

**The domain is part of the key.** A passkey works only on the domain it was made for, so its PRF values do too.
Moving the app to another domain orphans every wrapping, and every partner re-enrols through the operator. The domain
must be fixed before the first real enrolment (question 5).

### PRF support, and what happens without it

Tested support as of August to October 2026, from Corbado's matrices
([PRF](https://www.corbado.com/blog/passkeys-prf-webauthn), updated 2026-09-29;
[credential managers](https://www.corbado.com/blog/webauthn-l3-credential-manager-support.md), updated 2026-10-03):

| Works | Does not, or not reliably |
|---|---|
| Apple Passwords (iCloud Keychain): iOS and iPadOS 18+, macOS 15+ in Safari 18+, Chrome 132+, Firefox 139+ | **Windows 10: no PRF at all**, in any browser, including by phone over QR |
| Google Password Manager on Android (Chrome, Edge, Samsung Internet) | Windows Hello before the February 2026 Windows 11 update, or in Chrome/Edge before 147 (146: sign-in only) |
| Windows Hello on Windows 11 24H2/25H2 with the February 2026 update, in Chrome/Edge 147+ or Firefox 148+ | Microsoft Password Manager: creation works, every later use fails |
| Security keys with `hmac-secret` (YubiKey firmware 5.2+, [Yubico](https://developers.yubico.com/Passkeys/Passkey_concepts/Security_key_capabilities/Pseudo-Random_Function_PRF_Support.html)) in Chrome, Edge and Firefox | Security keys in Safari: only from 26.4, with two open WebKit bugs |
| 1Password, Proton Pass, Keeper, Enpass | Dashlane, NordPass: nothing returned to sites. Bitwarden: varies by platform. Samsung Pass: no value at creation, a value on later use |
| Cross-device (QR) with an iPhone on iOS 18.4+ or an Android phone | iOS 18.0 to 18.3 as the phone in a QR flow: wrong or missing values ([Apple forum](https://developer.apple.com/forums/thread/774112)). Chrome's own profile authenticator: no PRF |

Chrome has shipped the extension since version 116 (2023); what varies is the authenticator behind it.

**Where PRF is unavailable, Knotwork refuses; there is no weaker fallback (recommended, question 2).**
- At enrolment: no PRF result means no enrolment on that authenticator, with a message naming what does work
  (a phone's built-in passkey over QR, or a security key).
- At use: if the PRF value is missing or does not unwrap `K`, the action is refused and nothing is sent.
- The partner can still sign in, read and edit everything that is not a designated action. Only proposing and
  deciding need the passkey.
- Capability flags are not trusted (the matrix records browsers reporting PRF while the manager returned nothing);
  the test is whether a real PRF value came back and unwrapped a test value.

### What is closed, and what is not

**Closed, once steps 0 to 6 have landed** (enforce mode on, `search_path` pinned, the trigger on, the owner set
frozen, the owner URL out of the app):

- Raw SQL on `app_rw` or `app_sys` (T2, T3) cannot approve as a partner, invent a proposer, or invent a decider. It
  cannot write a signature, read or write `knotwork_private`, log in as a partner (it has no `K`, and the wrapped
  copies need the partner's authenticator), create or alter a role, change a function or disable a trigger (it owns
  nothing), or add an owner to a paired workspace.
- A leaked app environment holds no owner URL and no role-creating credential.
- A forged web session gets the forger the real pages and no passkey.
- A copy of the database (a dump, a branch) holds password check values and wrapped blobs, not passwords.

**Not closed. Each of these is exact:**

1. **The server can still act as a partner who is present (T5).** The page that asks for the passkey is served by the
   server. Whoever controls the server's code, or injects a script into that page, can show one request and sign
   another, or copy `K` once it is unlocked and use it afterwards from anywhere until the operator resets it. This
   needs the partner to touch their authenticator on a compromised page; it cannot be done for an absent partner or
   from anything at rest. No browser-based design avoids it. `connect-src` and the app's existing output escaping
   narrow the injected-script half.
2. **The operator (T4).** The owner URL, `knotwork_provisioner`, the Neon console and the Neon API key (whose
   "reset password" call sets a new password on any role, [roles](https://neon.com/docs/manage/roles)) can each
   become any partner. So can Neon's staff.
3. **Who the second partner is.** The first partner chose them at pairing, and the operator's fingerprint check is
   only as good as the out-of-band channel.
4. **Until step 6 lands, the owner URL is still in the app**, and finding 1 is not closed under Q2.
5. **The demo couple is public by design (Q7):** anyone can sign as either demo partner, in the demo workspace only.
   **Denials, not forgeries, also stay possible from raw SQL on the app's login:** marking a pending request
   `expired` or deleting it (expiry needs no signature); deleting a membership or a wrapped password; and, inside
   its 10-minute window, spending a decider's genuine unused `approve` signature on an approval whose action is
   never executed. Each wastes a real request; none approves anything a partner did not sign.
6. **Local development and CI do not have the browser-to-Neon path** (question 3): there the password passes through
   a local-only relay. Synthetic data only.
7. **Four Neon behaviours the design leans on are unproven** (spikes N1 to N4, section 7). If N3 fails (a browser
   cannot reach Neon as a SQL-created role), the chosen route does not exist on Neon and the plan returns to Shane.

---

## 4. The demo couple (Q7)

- `seed:couple` makes Juniper and Rowan as today (`scripts/knotwork/seed-couple.ts`), and the Knotwork role script
  creates their two partner roles with **public passwords** written in the repository (random, above Neon's 60 bits),
  as the demo TOTP seed is public today (`DEMO_TOTP_SECRET`, imported at `seed-couple.ts:28`). Their mapping rows
  name the demo workspace only, so a demo login can sign nothing anywhere else, whatever `Membership` says.
- A demo account is shared by every `/demo` visitor (`src/core/auth/session.ts:103-104`) and has no authenticator, so
  for `isDemo` users the page skips the passkey prompt and uses the public password. Everything after that is the
  same: the same browser connection, the same `knotwork_sign`, the same trigger. **There is no exemption in the
  database** for a forger to aim at.
- `twoKey()` in the seed (`seed-couple.ts:62-66`) signs as each demo partner before `propose` and `decide`.
- Demo logins exist only where `DEMO_MODE=1` data is seeded. On a deployed demo, anyone who learns the host can
  connect as a demo partner and do what section 3 lists (sign for the demo workspace, read catalogs). The connection
  limit bounds it.

---

## 5. Hosting: Neon

| Topic | What Neon's docs say | What it means here |
|---|---|---|
| Pooler | "PgBouncer in transaction mode"; `SET`/`RESET`, `LISTEN`, SQL-level `PREPARE` and session advisory locks are not supported on pooled connections; a pool per user and database, each up to 90% of `max_connections` ([pooling](https://neon.com/docs/connect/connection-pooling)) | `withOrg`'s transaction-local `set_config` keeps working (spike S4a, `spikes/s4`, already ran through it). A signature is one statement, so it needs no session state |
| Roles | 500 per branch; SQL-created roles get no `neon_superuser` membership; console and API roles do ([roles](https://neon.com/docs/manage/roles)) | about 245 couples a branch; partner roles are made in SQL only |
| Passwords | plain text only, 60 bits minimum, "Hashed passwords are not supported"; a reset "takes effect immediately" | the sealed-to-operator enrolment; a reset locks the old password out at once |
| Browser access | the serverless driver sends queries over HTTPS and has a browser mode ([serverless driver](https://neon.com/docs/serverless/serverless-driver)) | the partner's route. The page does not say whether HTTP queries pass through PgBouncer; it does not matter to a one-statement call |
| `CREATEROLE` for a SQL-created role | not stated | spike N1; fallback is the owner role in the operator's scripts |
| `BYPASSRLS` for a SQL-created role | not stated. Postgres lets only a role that has `BYPASSRLS` grant it ([CREATE ROLE](https://www.postgresql.org/docs/18/sql-createrole.html)); Neon's owner has it | spike N2, needed for `app_sys` (section 6) |

---

## 6. Taking the owner URL out of the running app (Q2, second half)

**Today** the owner is the system client (`DATABASE_URL_SYSTEM`) and the migration URL (`DIRECT_URL`), and the README
puts both in Vercel (section 1).

**After:**

- **`DATABASE_URL_SYSTEM` becomes `app_sys`**: a login with `BYPASSRLS` that owns nothing. `asSystem` needs to cross
  workspaces, which `BYPASSRLS` gives; it does not need to own tables. A non-owner cannot disable a trigger, replace a
  function or alter a role, so every guard binds `app_sys` exactly as it binds `app_rw`. **This needs no change to
  template-owned code**: `src/core/db/system.ts` connects to whatever URL it is given. `app_sys` gets the same table
  grants as `app_rw`, plus `SELECT` on `_prisma_migrations` (the export manifest reads it,
  `src/core/db/cross-org.ts:11`). Whether any `asSystem` path needs more than that is proven by running the enforce
  leg with `app_sys` in place; if one does, it is listed and decided, not granted quietly.
- **`DIRECT_URL` is not set in the app's environment at all.** `src/core/env.ts:9` already makes it optional.
- **Migrations run outside the app**, as the owner, in one of two places: the operator's machine
  (`prisma migrate deploy` with the owner URL from the password manager), or a manually started GitHub Actions
  workflow that holds the owner URL as a secret of a protected environment and does nothing else. Recommended: the
  operator's machine for now (nothing is deployed), the workflow when there is a deployment. The workflow is a new
  file; it is never part of the app's build, and `vercel.json` stays as it is.
- **Role setup moves with it.** A Knotwork script (`scripts/knotwork/`, run by the operator as the owner) creates
  `app_rw`, `app_sys`, `knotwork_provisioner` and the grants. It replaces the SQL block in `README.md` for Knotwork.

**What changes in CI and the templates:**

- `ci.yml`'s enforce step (lines 57 to 65) today sets `DATABASE_URL_SYSTEM` to the superuser URL. It will create
  `app_sys` beside `app_rw` and point `DATABASE_URL_SYSTEM` at it, so CI runs the shape that ships. The owner URL
  stays in the job as `DIRECT_URL` for `prisma migrate deploy` and, under a new test-only name, for fixtures.
- **Tests need an owner connection of their own.** Several tests disable a trigger to prove it matters, which only
  the owner can do, and the eleven `e2e/*.spec.ts` files open `DATABASE_URL_SYSTEM ?? DATABASE_URL` "as the owner"
  for fixtures. Those move to a test-only owner URL read in `tests/` and `e2e/` only. A structure test holds that
  nothing in `src/` or `scripts/` (outside the operator scripts) reads it. Template-owned tests that rely on
  `dbSystem` being the owner are a template change (below).
- A new invariant for the enforce leg: the role behind `DATABASE_URL` and the role behind `DATABASE_URL_SYSTEM` are
  not superusers, have no `CREATEROLE`, own no table or function, and are not members of the owner.
- `docs/knotwork/PRODUCTIONIZE.md` gains the Neon section: which URL goes where, that no owner URL goes in the host's
  settings, the operator's scripts, the fixed domain, no preview branches from a branch with real partners.
- **Template-owned and therefore not edited by Knotwork:** `README.md`'s "Row-level security on Neon" section,
  `.env.example`, `scripts/db-setup.ts` (which writes the owner as `DATABASE_URL_SYSTEM` locally), and
  `tests/invariants`. Locally the owner stays in `.env.local` as today (a laptop database); the shipped shape is what
  CI's enforce leg and the productionize note describe. The same change is worth making upstream in the template;
  that is a template item, recorded in the D-rows, not done here.

---

## 7. Rollout, tests, CI

### Steps (each its own draft PR; each with a migration waits for Shane, none merges by the loop)

0. **Pin the guards' `search_path`.** In progress in its own PR (#11, `fix/guard-search-path`, D-199). Not part of
   this plan's work. Everything below assumes it has merged.
1. **Enforce leg green.** The variable is set (Q5); the first run of `ci (enforce)` on Knotwork will show what it
   finds. Fix that first. No guard changes.
2. **Spikes, no product code.** They need a Neon project, which is Shane's to create.
   - N1: the owner creates a SQL role with `CREATEROLE` and grants it `knotwork_partner WITH ADMIN OPTION`; that
     role creates a login `IN ROLE knotwork_partner` (since Postgres 16 this fails without the admin option), alters
     and drops it; it cannot touch `app_rw` or the owner.
   - N2: the owner creates a `BYPASSRLS` login that owns nothing; the enforce suite passes with it as the system URL.
   - N3: a SQL-created login with no grants calls a function from a real browser through the serverless driver over
     HTTPS; `session_user` inside the function is that login; note the CORS behaviour and what the role can see.
   - N4: how long a per-role connection lingers after an HTTP query; behaviour at `CONNECTION LIMIT`; round-trip time
     warm and after scale-to-zero.
   - P1: PRF on the devices Shane and a second person actually use: create, `get()`, same value twice, the same
     synced passkey on two devices, and one cross-device run.
   If N1 or N2 fails, the stated fallbacks apply. If N3 fails, stop and return to Shane.
3. **The owner-set freeze (D-207).** Its own migration and tests. It depends on nothing else here.
4. **Schema and enrolment, not yet required.** Migration: `knotwork_private`, the mapping and signature tables, the
   `knotwork_partner` group (created only if absent, since roles outlive a database and CI's shadow database replays
   every migration on the same server), `knotwork_sign`, `knotwork_request_digest`, the revoke from `PUBLIC`, the two Prisma models. App: the enrolment page, add-a-device, the "this device can sign" line.
   Operator scripts: role setup, enrol, reset, sweep. Seeds: the demo logins. Guards unchanged, so nothing is refused.
5. **Guards on.** Migration: `ConsentRequest_proven_actor`. App: prepare, sign, commit on every designated action.
   Seeds and tests sign. From here a partner without an enrolled passkey cannot propose or decide.
6. **The owner URL out of the app** (section 6). Independent of 4 and 5; can go earlier.
7. **Docs.** The D-rows below, NEXT.md, CLAUDE.md rule 2, `PRODUCTIONIZE.md`.

No data migration: there is no deployed database, and old approved rows are not re-checked. Local databases are
re-seeded. Reversal at any step: drop the trigger in a new migration.

### Tests

**Attacks. Each by raw SQL after the real actions, each on the enforce leg as `app_rw` and again as `app_sys`, each
failing when its trigger is switched off (D-197's method):**

1. Approve naming the real other partner, with no signature: refused.
2. Approve with the forger's own genuine signature (a partner approving their own request): refused.
3. Insert a request with a made-up proposer, or with the other partner as proposer: refused.
4. Insert a `Session` row for the other partner and approve through the real action as them: refused by the database.
5. Call `knotwork_sign` as `app_rw`, `app_sys` and the owner: refused. Read or write `knotwork_private`: refused.
6. `SET ROLE` to a partner role, `SET SESSION AUTHORIZATION`, `CREATE ROLE`, `ALTER ROLE … PASSWORD` on a partner
   role: all refused.
7. Reuse a consumed signature; use request X's signature for request Y; use an 11-minute-old signature; change
   `payload` or `summary` after signing: all refused.
8. Solo: a solo approval with no `propose` signature: refused.
9. The owner set: a new owner in a paired workspace by raw SQL; remove a partner and add another; re-point an
   owner row's `userId` or `orgId`; a third owner before pairing in a workspace with a wedding: all refused.
10. A temporary table or a changed `search_path` around any guarded statement changes nothing (step 0's test, kept).
11. As a partner role on its own connection: read any Knotwork table, write the signature table directly, sign with
    another user's id, sign from a retired or never-activated role: all refused. A signature with no following write
    changes nothing.
12. After an operator reset: the old password no longer logs in; unused signatures made with it no longer count.
13. Replace or delete a partner's wrapped password, or file an enrolment in their name, as `app_rw`: the partner is
    locked out or the operator's fingerprint check fails; no approval results.
14. The runtime roles: the invariant in section 6 (no superuser, no `CREATEROLE`, own nothing).
15. In a never-paired workspace, replace its one owner by raw SQL with (a) a demo user, (b) an enrolled partner of
    another workspace, then propose in solo mode with that login's genuine signature: refused (the login is not
    enrolled for this workspace).
16. One partner signs `approve` for a request they proposed, before the other does: the other partner's approval
    still goes through.

**Legitimate paths that must still pass:** two keys through the real actions with two enrolled partners; solo;
decline, withdraw, expiry by the sweep and by cron; a re-proposal; approval after the proposer left the workspace;
a retry after an execution refusal inside the signature window; enrol, add a second authenticator, sign with each;
operator reset, fresh enrolment, approval; a second partner joining by invite and by SSO; `deleteOrg` and
`deleteAccount`, then the sweep dropping the role; `seed:couple`; every existing consent test.

**The demo:** `/demo` proposes as Juniper and approves as Rowan with the public logins, through the browser path, and
the attack tests above pass against the demo workspace exactly as against any other.

**Passkeys in e2e:** Playwright's Chromium, with a virtual authenticator created through the DevTools protocol;
`VirtualAuthenticatorOptions.hasPrf` exists for this: "If set to true, the authenticator will support the prf
extension" ([WebAuthn.pdl](https://chromium.googlesource.com/devtools/devtools-frontend.git/+/HEAD/node_modules/devtools-protocol/pdl/domains/WebAuthn.pdl)).
One spec enrols, runs the operator script, proposes and approves; one checks that an authenticator without PRF is
refused at enrolment.

**Existing tests that change, none weakened.** Every test that reaches a designated action gains a signing step
through one shared helper (it connects as the test partner's role). That is more than the six files that write
requests directly (`tests/fixtures/app.ts`, `guard-d172`, `guard-used-request`, `secrecy-db`, `solo`, `two-key`,
18 call sites), because most tests go through the actions; the full count is taken at build. `forged()` in
`guard-d172.test.ts:58` cannot stay as raw SQL: its approved-but-never-executed requests are built with both test
partners' signatures. The test at line 355 ("NOT closed, recorded in D-190") becomes attacks 1 to 4. The harness row
in `tests/fixtures/app.ts:26-29` proposes from a non-member id and has to propose as an enrolled owner (D-190 named
this). The trigger fires for the owner role too.

### CI

- `ci (enforce)` runs on every PR (Q5) and becomes the leg that models the shipped shape: `app_rw`, `app_sys`, no
  owner behind either app URL (section 6).
- Its role step grants on schema `public` only (`ci.yml:62`), which is why the mapping and signature tables live in
  their own schema: neither that step nor `db-setup.ts`'s `grantApp` can hand them to the app by accident.
- CI's Postgres has a real superuser, which stands in for the owner. The enrolment test runs as a real non-superuser
  `knotwork_provisioner` (so the `IN ROLE` and admin-option rules of Postgres 16+ are exercised on Postgres 17 in
  CI); N1 repeats it by hand on Neon.
- "Migrations match the schema" (`prisma migrate diff --exit-code`, `ci.yml:52-56`) must stay green with tables
  outside `public` and a migration that creates a role. Expected, not yet proven: step 4's PR proves it or moves the
  tables.
- CI has no Neon HTTPS endpoint, so the browser's signing call needs a local stand-in (question 3).
- `structure.test.ts` gains: the new migrations have no `CREATE OR REPLACE` or `DROP` of an old object; no file in
  `src/` names `knotwork_private`, the provisioner or the test-only owner URL; no file in `src/` creates or alters a
  role; every designated action goes through prepare, sign, commit.

---

## 8. New open questions, one at a time

**1. Who approves an enrolment?**
(a) The operator, by hand, for every partner, after checking the fingerprint out of band. (b) A separate small
service that holds the role-creating credential and approves automatically. (c) The app itself holds the credential.
**Recommendation: (a).** It matches Q4 (the operator is already the only one who can reset), and it is the only
option where a forger with the app's login cannot enrol in a partner's name. Its cost: a new couple cannot book,
sign, spend over the threshold or move the date until the operator has approved each of them. (b) moves the main
risk onto a second server; (c) puts it in the leaked-environment case and reopens finding 1.

**2. A device with no PRF.**
(a) Refuse: that device cannot propose or decide; the partner uses a phone or a security key. (b) Offer a printed
recovery code (the password itself, typed when needed). (c) Let the server hold the password for those partners.
**Recommendation: (a).** (b) is a second secret that can be photographed or pasted into the wrong page, and it would
become the path everyone uses; (c) breaks Q3. The device most likely to be refused is a Windows 10 PC; a phone over
QR does not rescue it (section 3).

**3. Local development and CI, where there is no Neon endpoint.**
(a) A relay route that answers only when the database host is literally `localhost` or `127.0.0.1` and `VERCEL` is
unset (not the template's `local-guard.ts`, which only recognises three cloud host names and would let any other
host through): the browser sends the password to the local server, which opens the partner
connection. (b) Run a Neon-compatible HTTP proxy container beside local Postgres.
**Recommendation: (a), with a test that the route refuses every other host and refuses under `VERCEL`.** The one published
local proxy ([Neon's guide](https://neon.com/guides/local-development-with-neon) uses a community image) connects
upstream with a single fixed role, so it cannot stand in for per-partner logins as it is. (a) does put a
password-through-the-server path in the codebase; it carries only synthetic logins.

**4. Past about 245 couples.**
(a) Stop enrolling at the cap and decide then. (b) Ask Neon for a higher limit. (c) Plan now for a second branch or
project. (d) Fall back to option D beyond the cap.
**Recommendation: (a).** Knotwork has no real couples; the enrolment script makes the cap visible long before it is
reached, and (b) to (d) are better judged with real numbers.

**5. The domain.**
Passkeys, and so every wrapped password, are tied to the site's domain.
(a) Choose the permanent domain before the first real couple enrols. (b) Start on a provisional domain and re-enrol
everyone through the operator on moving.
**Recommendation: (a).**

**6. Confirm the consequence of Q3: the partner's browser talks to the database host directly.**
(a) Yes, as designed. (b) No: route it through the server and accept that the password is in the server's memory
during each approval.
**Recommendation: (a).** It is the only route found that meets Q3 as worded. It is listed because it is new
architecture: the database host becomes reachable, with a real login, from a partner's browser.

---

## Proposed D-rows (add once the `search_path` PR and this plan merge)

In `docs/knotwork/decisions.md`'s shape. Numbered from D-200 (D-199 is taken by the `search_path` PR, #11). Not added
to `decisions.md` by this PR.

| # | Date | Question | Options | Decision | Reversal |
|---|---|---|---|---|---|
| D-200 | 2026-11-28 | **Owner decision (Shane): how the database learns who is acting; closes D-190's open half** | (A) `SET ROLE` from the pooled login; (B) an identity the app signs; (C) a Postgres login per partner; (D) a key per partner checked by a function | **(C).** (A) is refused: the same raw SQL can switch roles. (B) is refused: the app's login can insert a `Session`. (D) closes the same raw-SQL attacks and was the first draft's recommendation; not chosen because the decision is for a real login authenticated by Postgres with a passkey-held credential, and D's key is read by the server on every approval | drop the trigger in a new migration; D stays possible |
| D-201 | 2026-11-28 | **Owner decision: what "closed" means for finding 1** | raw SQL on the app's login only; that, and no owner URL in the running app | **Both.** Raw SQL on `app_rw` or `app_sys` can neither approve as a partner, nor invent a proposer or a decider; and the owner URL and the role-creating credential are not in the app's environment. Not closed, by design or by nature: the operator and the host; a fully controlled server or an injected script, while a partner is using their passkey on that page; who the second partner is; the public demo couple | none |
| D-202 | 2026-11-28 | **Owner decision: RLS enforce mode for Knotwork** | optional (the template's default); required | **Required**; `ci (enforce)` runs on every PR (repo variable `RLS_ENFORCE=1`) | unset the variable |
| D-203 | 2026-11-28 | **Owner decision: the host** | Neon, Supabase, RDS, self-hosted | **Neon.** Partner roles are made in SQL only (console and API roles join `neon_superuser`). 500 roles a branch, about 245 couples; enrolment refuses at 490 | a different host changes the browser route and the enrolment step, not the guards |
| D-204 | (on build) | How a statement runs as the partner when the server may not hold the password | the server opens the connection; the browser connects to Neon; a relayed handshake | **The browser connects to Neon** and calls `knotwork_sign(action, request, digest)`, which reads `session_user`. The app's transaction is unchanged and a new trigger, after the existing three (D-196), requires the matching signature: insert, the proposer's; approve, the decider's and the proposer's; solo (D-33), the proposer's; decline and withdraw, their actor's; expiry, none. The digest covers `summary` | drop the trigger in a new migration |
| D-205 | 2026-11-28 | **Owner decision: where a partner's credential lives** | a cookie; a typed phrase; a passkey | **A passkey.** The password is random, wrapped under a key the passkey derives (WebAuthn PRF), unwrapped only in the browser. No PRF, no enrolment and no signing on that device: refused, with no weaker fallback | a fallback would be a new decision |
| D-206 | 2026-11-28 | **Owner decision: enrolment, loss** | signing in is enough; the other partner resets; operator only | **Operator only.** `knotwork_provisioner` (`CREATEROLE`) is held by the operator and is never in the app or CI. Enrolment: the browser seals the password to the operator's public key; the operator checks a fingerprint out of band and creates the role, enrolled for named workspaces only. A lost passkey: the operator drops the role and the partner enrols again. Each writes an audit line | a provisioning service would be a new decision |
| D-207 | 2026-11-28 | **Owner decision: the owner set.** One partner could make a third owner and approve as it | leave; freeze at pairing; make a new owner a designated action | **Frozen at two once paired**, in this change: a workspace with a wedding has at most two owners, and once paired no membership becomes an owner (triggers on `Membership` and on `Wedding` insert, from a clone migration, as D-56). Replacing a partner is an operator act | drop the triggers in a new migration |
| D-208 | 2026-11-28 | **Owner decision: the shared demo couple** | exempt demo workspaces from the guard; public demo logins | **Public demo logins**, seeded; the demo skips the passkey prompt and runs through the same function and trigger. No exemption in the database | none |
| D-209 | (on build) | The owner URL in the running app | keep it as the system client; replace it | **`DATABASE_URL_SYSTEM` is `app_sys`** (`BYPASSRLS`, owns nothing); `DIRECT_URL` is unset in the app; migrations run as the owner from the operator's machine or a manual workflow. No template-owned file is edited; the README, `.env.example` and `db-setup.ts` wording is a template item | point the system URL back at the owner |
| D-210 | (on build) | Tests | — | The sixteen attacks, the legitimate paths, the demo and the two passkey specs in the plan; each attack fails with its trigger off; `forged()` uses both partners' signatures; the "NOT closed" test becomes attacks 1 to 4. Nothing deleted, skipped or weakened | none |

---

## Not verified

- **The repo variable `RLS_ENFORCE`.** Its value cannot be read from this session. On `main` at `4db2ec7` and on this
  branch's previous head `4acced1` the check runs are `ci (off)`, `modules-removed` and `oracles`, with **no
  `ci (enforce)`**; both runs started about 14:00 UTC on 2026-11-28, which may be before the variable was set. What
  the commit carrying this revision shows is reported in the PR body.
- **Neon, all four:** that a SQL-created role may hold `CREATEROLE` (N1); that a SQL-created, non-owner role may hold
  `BYPASSRLS` (N2); that a browser can run a statement as a SQL-created role through the serverless driver, with
  `session_user` being that role, and what CORS allows (N3); idle connection behaviour per role (N4). No Neon account
  was used or created for this plan.
- **That a Neon child branch carries its parent's roles and passwords** (section 3, "Branches"): stated from general
  knowledge of Neon branching; the page was not read.
- **That an ordinary Neon role sees only what `PUBLIC` sees in stock Postgres** (Neon's roles page says so in one
  sentence; not tested).
- **PRF on real devices.** The support table is Corbado's testing, not this session's; its own page warns its
  community figures come from small samples. Apple's forum thread ends without Apple confirming the cross-device fix
  that Corbado dates to iOS 18.4. Yubico's page gives firmware, not browsers.
- **That no `asSystem` path needs table ownership** (section 6). Read from `cross-org.ts`'s reasons, not run.
- **That `prisma migrate diff` ignores tables outside `public`** and tolerates a role-creating migration.
- **That no template test needs three owners in an org that has a wedding** (the owner-set freeze).
- **The earlier temporary-table reproduction** was on a scratch Postgres 16 with a guard of the same shape, not on
  Knotwork's schema; the `search_path` PR owns that now.
- **Line counts and totals** were taken with `git grep` on `4db2ec7`; the test count that will change is a floor.
- One page could not be read: `github.com/neondatabase/serverless` (the driver's README). The driver claims above
  come from Neon's docs page only.
- Nothing in the repository was run.

---

## Reviews

### First draft (one fresh agent, 2026-11-28)

Verdict "do not adopt as written", four must-fixes, all taken at the time: no reset the app's login can call; the
owner set frozen at pairing; guards pin `search_path`; the enrolment gap stated exactly. The first three carry into
this revision unchanged in substance (Q4, Q6, step 0). The fourth is now answered by the operator's fingerprint check.

### This revision (one fresh agent, 2026-11-28)

One independent agent (`claude -p`, read-only, given the repository at `4db2ec7`, this file and Shane's decisions).
Verdict: "Sound in principle and honest about the server-while-present gap, but not adoptable as written." It could
not fetch pages directly, so its web checks rest on search results and its own knowledge. Three must-fixes, all held,
all taken:

1. **The freeze did not cover re-pointing an existing owner row** (`UPDATE "Membership" SET "userId" = …` keeps the
   role). Changed: an owner row's `userId` and `orgId` never change once paired; added to attack 9.
2. **On Postgres 16+ the provisioner could not create a partner role `IN ROLE knotwork_partner`** without the admin
   option on the group. Changed: the role setup script grants it; N1 and the CI enrolment test exercise it as a
   non-superuser.
3. **The new trigger function must be `SECURITY DEFINER`** or every insert fails as `app_rw`. Changed: stated for
   both functions, with a structure test.

Should-fixes taken: synced passkeys are no longer assumed to give the same PRF value (every device is added as an
authenticator; P1 tests it); the opening paragraph no longer says "never for an absent partner" without the
since-last-reset condition; `statement_timeout` is set per role; nothing retires a login when a workspace is deleted;
the local relay is gated on the literal host, not `local-guard.ts`; eight `propose` sites, not nine. Nits taken: the
import line, full paths, D-207 marked as proposed, the denial-only routes, the operator's public key in the
repository, provisioner rotation. Not changed: Neon's "minimum entropy of 60 bits" is quoted as the page read here
gave it (the reviewer's copy says "approximately").

Found by the author after the review started, and so **not seen by the reviewer**: logins are enrolled per workspace
(the never-paired membership swap, attack 15); signatures are keyed by user as well (attack 16); `summary` is pinned;
no revoke of the existing guard helpers from `PUBLIC`.
