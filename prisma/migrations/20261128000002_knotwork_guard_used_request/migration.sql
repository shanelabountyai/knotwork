-- Knotwork D-170 (review of PR #6, should-fix 2): the wedding's designated guards (the date and the approval rules in
-- Wedding_guard, the mode in Wedding_mode_guard) refused a change only when it named the PREVIOUS request. An executed
-- request stays 'approved', so a direct UPDATE could name an older approved request again after another one had been
-- used (mode A -> B, then A again). Now a request can be used once: the wedding keeps the ids of every request its
-- date, rules and mode have ever been changed with (prisma/schema/knotwork.prisma, Wedding.usedRequestIds), and a change
-- that names one of them is refused. Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code`
-- proves it matches the schema.

-- AlterTable
ALTER TABLE "Wedding" ADD COLUMN     "usedRequestIds" UUID[];

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in Prisma's schema language: the database half.

-- BACKFILL. Every approved change_date, change_settings or set_mode request of the workspace has already been used:
-- a request is executed in the transaction that approves it (consent/execute.ts; "ConsentRequest_executed_check"), so
-- an approved request is an executed one. The ids the wedding names today are included in any case.
UPDATE "Wedding" w SET "usedRequestIds" = ARRAY(
  SELECT r."id" FROM "ConsentRequest" r
  WHERE r."orgId" = w."orgId"
    AND ((r."kind" IN ('change_date', 'change_settings', 'set_mode') AND r."status" = 'approved')
         OR r."id" IN (w."dateRequestId", w."settingsRequestId", w."modeRequestId"))
  ORDER BY r."executedAt" NULLS LAST, r."id"
);
-- END BACKFILL

-- RULE 2 (D-170): a request is used once. Whenever the wedding's dateRequestId, settingsRequestId or modeRequestId takes
-- a new value, that value must not be one the wedding has used before, and it is added to the list. The list is the
-- database's own: no writer may set it. A wedding is born with the workspace's approved requests of those three kinds
-- already on it (normally none), so deleting and re-creating the wedding does not make an old request new again. The
-- other guards are unchanged: they still check that the request is approved, of the right kind, and (for the mode)
-- names that mode.
CREATE FUNCTION knotwork_wedding_request_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  used uuid[];
  req uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    used := ARRAY(
      SELECT r."id" FROM "ConsentRequest" r
      WHERE r."orgId" = NEW."orgId" AND r."kind" IN ('change_date', 'change_settings', 'set_mode') AND r."status" = 'approved'
      ORDER BY r."executedAt", r."id"
    );
    FOREACH req IN ARRAY ARRAY[NEW."dateRequestId", NEW."settingsRequestId", NEW."modeRequestId"] LOOP
      IF req IS NOT NULL THEN
        IF req = ANY(used) THEN
          RAISE EXCEPTION 'knotwork two-key: that request has already been used; a change needs an approved request never used before' USING ERRCODE = 'check_violation';
        END IF;
        used := used || req;
      END IF;
    END LOOP;
    NEW."usedRequestIds" := used;
    RETURN NEW;
  END IF;
  IF NEW."usedRequestIds" IS DISTINCT FROM OLD."usedRequestIds" THEN
    RAISE EXCEPTION 'knotwork two-key: the list of used requests is kept by the database' USING ERRCODE = 'check_violation';
  END IF;
  used := coalesce(OLD."usedRequestIds", '{}');
  IF NEW."dateRequestId" IS NOT NULL AND NEW."dateRequestId" IS DISTINCT FROM OLD."dateRequestId" THEN
    IF NEW."dateRequestId" = ANY(used) THEN
      RAISE EXCEPTION 'knotwork two-key: that request has already been used; a change needs an approved request never used before' USING ERRCODE = 'check_violation';
    END IF;
    used := used || NEW."dateRequestId";
  END IF;
  IF NEW."settingsRequestId" IS NOT NULL AND NEW."settingsRequestId" IS DISTINCT FROM OLD."settingsRequestId" THEN
    IF NEW."settingsRequestId" = ANY(used) THEN
      RAISE EXCEPTION 'knotwork two-key: that request has already been used; a change needs an approved request never used before' USING ERRCODE = 'check_violation';
    END IF;
    used := used || NEW."settingsRequestId";
  END IF;
  IF NEW."modeRequestId" IS NOT NULL AND NEW."modeRequestId" IS DISTINCT FROM OLD."modeRequestId" THEN
    IF NEW."modeRequestId" = ANY(used) THEN
      RAISE EXCEPTION 'knotwork two-key: that request has already been used; a change needs an approved request never used before' USING ERRCODE = 'check_violation';
    END IF;
    used := used || NEW."modeRequestId";
  END IF;
  NEW."usedRequestIds" := used;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Wedding_request_once" BEFORE INSERT OR UPDATE ON "Wedding" FOR EACH ROW EXECUTE FUNCTION knotwork_wedding_request_once();
