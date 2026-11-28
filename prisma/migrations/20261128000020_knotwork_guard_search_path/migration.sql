-- Knotwork D-199: pin search_path on every trigger and guard function, with pg_temp LAST.
--
-- THE HOLE. No Knotwork guard function set search_path, and each names its tables unqualified ("ConsentRequest",
-- "Membership", "Wedding", "Org"). For tables, Postgres looks in the session's temporary schema FIRST, and every role
-- may create temporary tables. So the app's own login could CREATE TEMP TABLE "ConsentRequest", put an "approved" row
-- in it, and knotwork_require_approved (and every other guard) read that row instead of the real one: the date, the
-- approval rules, a spend over the threshold, the wedding's deletion and a helper's "approval" all went through with
-- no second key (tests/knotwork/guard-search-path.test.ts, each attack run as a role that owns nothing).
--
-- THE FIX. ALTER FUNCTION ... SET search_path = pg_catalog, public, pg_temp. pg_temp is named, and named last, on
-- purpose: when pg_temp is not in the list, Postgres still searches it, FIRST. `pg_catalog, public` alone leaves the
-- hole open (tried: the same attacks go through). Named last, a temporary table, view, sequence or type is found only
-- when no real one in pg_catalog or public has the name; and the temporary schema is never searched for functions or
-- operators at all.
--
-- WHICH FUNCTIONS. Not a list kept by hand: every function in this schema that no extension owns, read from pg_proc
-- when the migration runs. On the day it was written that was 37: the 34 knotwork_* functions (33 trigger functions
-- and knotwork_require_approved), and the template's three (audit_event_append_only, audit_event_no_truncate, and
-- org_event_assign_seq, which is SECURITY DEFINER and had `search_path = public`: the same hole, since pg_temp was
-- not named). No function body changes and no applied migration is edited: the SET clause is an attribute of the
-- function, beside its body. Nothing here is in the Prisma schema. Hand-written (D-04).
--
-- AFTER THIS. Every new function is created with `SET search_path = pg_catalog, public, pg_temp`. CREATE OR REPLACE
-- without that clause drops the pin. The structure test in guard-search-path.test.ts reads pg_proc and fails on
-- either. If a template upgrade re-creates one of its three functions without the clause, the remedy is a new Knotwork
-- migration that runs this same DO loop again (the template's migration is not edited). To undo: ALTER FUNCTION ... RESET search_path (and SET search_path = public on org_event_assign_seq).
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY p.proname
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f);
  END LOOP;
END $$;
