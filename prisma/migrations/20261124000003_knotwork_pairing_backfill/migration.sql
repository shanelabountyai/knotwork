-- Knotwork review 2026-11-24 (D-55): 20261124000000_knotwork_solo added "Wedding"."pairedAt" as NULL on every existing
-- wedding. A couple who were already two partners (Phase 1 data) would then count as "never paired" until someone
-- next loaded a wedding page, and one of them could remove the other first and act alone. This marks as paired every
-- wedding that has two partners now, or where a second person ever decided a request. Data only: no schema change.
-- Hand-written (D-04). Safe to run more than once: it only ever sets a NULL.
UPDATE "Wedding" w SET "pairedAt" = CURRENT_TIMESTAMP
WHERE w."pairedAt" IS NULL
  AND (
    (SELECT count(*) FROM "Membership" m WHERE m."orgId" = w."orgId" AND m."role" = 'owner') >= 2
    OR EXISTS (
      SELECT 1 FROM "ConsentRequest" r
      WHERE r."orgId" = w."orgId" AND r."deciderId" IS NOT NULL AND r."deciderId" <> r."proposerId"
    )
  );
