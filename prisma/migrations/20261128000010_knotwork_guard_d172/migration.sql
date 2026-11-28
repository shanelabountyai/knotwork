-- Knotwork D-190 to D-197: the five findings D-172 recorded from the independent review of PR #8, closed in the
-- database where the database can close them. Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff
-- --exit-code` proves it matches the schema. No applied migration is edited: every rule here is a new trigger beside the
-- old ones, named so that it runs after them (Postgres fires a table's BEFORE triggers in name order), so each old
-- refusal still comes first, with its old sentence.
--
--   1. a forged approval          "ConsentRequest_partner_guard"  PARTLY: the decider must be a partner of the workspace
--   2. burning a pending request  "Wedding_request_payload", "Expense_request_once"
--   3. vendor and expense reuse   "Vendor_request_once" (Vendor.usedRequestIds), "Expense_request_once"
--   4. deleting the wedding       "Wedding_delete_guard"
--   5. the payload                "Wedding_request_payload"

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "usedRequestIds" UUID[];

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in Prisma's schema language: the database half.

-- BACKFILL. Every approved book_vendor or sign_contract request that names this vendor has already been used: a
-- request is executed in the transaction that approves it (consent/execute.ts; "ConsentRequest_executed_check"), so an
-- approved request is an executed one (as D-171). The ids the vendor names today are included in any case.
UPDATE "Vendor" v SET "usedRequestIds" = ARRAY(
  SELECT r."id" FROM "ConsentRequest" r
  WHERE r."orgId" = v."orgId"
    AND ((r."kind" IN ('book_vendor', 'sign_contract') AND r."status" = 'approved' AND r."payload"->>'vendorId' = v."id"::text)
         OR r."id" IN (v."bookedRequestId", v."contractRequestId"))
  ORDER BY r."executedAt" NULLS LAST, r."id"
);
-- END BACKFILL

-- FINDING 3, vendors (D-191): a request books a vendor, or signs its contract, once. "Vendor_guard" asks for an
-- approved request whenever a vendor becomes booked, its contract becomes signed, the signing day changes or either
-- request id changes; an executed request stays approved, so un-booking the vendor (or clearing the signing day) and
-- doing it again with the same request passed. Now, every time "Vendor_guard" asks for a request, that request must
-- not be on the vendor's list, and it is added. The list is the database's own. A vendor is born with the approved
-- requests that name its id already on it (normally none), and takes them on if its id or workspace is changed, so
-- deleting and re-creating the row does not make an old request new again. And (finding 5's kind, D-198) a contract
-- is signed for the total its request approved, as the date and the rules now are.
CREATE FUNCTION knotwork_vendor_request_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  used uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    used := '{}';
  ELSE
    IF NEW."usedRequestIds" IS DISTINCT FROM OLD."usedRequestIds" THEN
      RAISE EXCEPTION 'knotwork two-key: the list of used requests is kept by the database' USING ERRCODE = 'check_violation';
    END IF;
    used := coalesce(OLD."usedRequestIds", '{}');
  END IF;
  IF TG_OP = 'INSERT' OR NEW."id" <> OLD."id" OR NEW."orgId" <> OLD."orgId" THEN
    used := used || ARRAY(
      SELECT r."id" FROM "ConsentRequest" r
      WHERE r."orgId" = NEW."orgId" AND r."kind" IN ('book_vendor', 'sign_contract') AND r."status" = 'approved'
        AND r."payload"->>'vendorId' = NEW."id"::text AND NOT (r."id" = ANY(used))
      ORDER BY r."executedAt", r."id"
    );
  END IF;
  IF NEW."status" = 'booked' AND NEW."bookedRequestId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD."status" <> 'booked' OR NEW."bookedRequestId" IS DISTINCT FROM OLD."bookedRequestId") THEN
    IF NEW."bookedRequestId" = ANY(used) THEN
      RAISE EXCEPTION 'knotwork two-key: that request has already been used; booking a vendor needs an approved request never used before' USING ERRCODE = 'check_violation';
    END IF;
    used := used || NEW."bookedRequestId";
  END IF;
  IF NEW."contractSignedOn" IS NOT NULL AND NEW."contractRequestId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD."contractSignedOn" IS NULL OR NEW."contractSignedOn" <> OLD."contractSignedOn" OR NEW."contractRequestId" IS DISTINCT FROM OLD."contractRequestId") THEN
    IF NEW."contractRequestId" = ANY(used) THEN
      RAISE EXCEPTION 'knotwork two-key: that request has already been used; signing a contract needs an approved request never used before' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."contractRequestId" AND r."payload"->'totalCents' = to_jsonb(NEW."contractTotalCents")) THEN
      RAISE EXCEPTION 'knotwork two-key: that request approved a different contract total' USING ERRCODE = 'check_violation';
    END IF;
    used := used || NEW."contractRequestId";
  END IF;
  NEW."usedRequestIds" := used;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Vendor_request_once" BEFORE INSERT OR UPDATE ON "Vendor" FOR EACH ROW EXECUTE FUNCTION knotwork_vendor_request_once();

-- FINDINGS 2 and 3, expenses (D-192). "Expense_guard" checks a request only when the amount is over the threshold, and
-- its "already been spent" looks for a living expense. So (3) deleting an approved expense made its request new again,
-- and (2) a small expense could name a pending spend request, whose approval was then refused as already spent.
-- Now an expense that names a request is never deleted while its workspace exists (the one exception, as for guests:
-- the whole workspace going, when the Org row is already gone), and ANY expense that names a request, whatever its
-- amount, needs that request approved, a spend request of this workspace, for this amount, and not spent yet.
CREATE FUNCTION knotwork_expense_request_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."requestId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Org" o WHERE o."id" = OLD."orgId") THEN
      RAISE EXCEPTION 'knotwork two-key: an approved expense is never deleted; its request would be new again' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."requestId" IS NOT NULL THEN
    PERFORM knotwork_require_approved(NEW."requestId", NEW."orgId", 'spend', 'an expense that names a request');
    IF EXISTS (SELECT 1 FROM "Expense" e WHERE e."requestId" = NEW."requestId") THEN
      RAISE EXCEPTION 'knotwork two-key: that request has already been spent' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."requestId" AND r."payload"->'amountCents' = to_jsonb(NEW."amountCents")) THEN
      RAISE EXCEPTION 'knotwork two-key: that request approved a different amount' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Expense_request_once" BEFORE INSERT OR DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION knotwork_expense_request_once();

-- FINDINGS 2 and 5, the wedding (D-193, D-194). (5) "Wedding_guard" asked for an approved change_date or
-- change_settings request but never read it: a request approved for one date could move the wedding to another (the
-- mode guard already reads its payload). Now the new date is the request's `to`, and the three new rules are the
-- request's three. (2) A request's id could be written to dateRequestId or settingsRequestId without the date or the
-- rules changing; it went on the used list, and its later approval was refused. Now either column takes a new request
-- only together with the change that request approved (it may still be cleared, as before: the list keeps the id),
-- and a wedding is born naming none. (4, with "Wedding_delete_guard" below) A wedding never moves to another
-- workspace: moving it away and inserting a new one was the same as deleting it.
CREATE FUNCTION knotwork_wedding_request_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dateRequestId" IS NOT NULL OR NEW."settingsRequestId" IS NOT NULL THEN
      RAISE EXCEPTION 'knotwork two-key: a wedding starts with no request; a request is named only by the change it approved' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."orgId" <> OLD."orgId" THEN
    RAISE EXCEPTION 'knotwork two-key: a wedding stays in its workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."date" <> OLD."date" THEN
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."dateRequestId" AND r."payload"->>'to' = to_char(NEW."date", 'YYYY-MM-DD')) THEN
      RAISE EXCEPTION 'knotwork two-key: that request approved a different date' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."dateRequestId" IS NOT NULL AND NEW."dateRequestId" IS DISTINCT FROM OLD."dateRequestId" THEN
    RAISE EXCEPTION 'knotwork two-key: a change_date request is named only when it changes the date' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."spendThresholdCents" <> OLD."spendThresholdCents" OR NEW."consentExpiryDays" <> OLD."consentExpiryDays" OR NEW."chaseBufferDays" <> OLD."chaseBufferDays" THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."settingsRequestId"
        AND r."payload"->'spendThresholdCents' = to_jsonb(NEW."spendThresholdCents")
        AND r."payload"->'consentExpiryDays' = to_jsonb(NEW."consentExpiryDays")
        AND r."payload"->'chaseBufferDays' = to_jsonb(NEW."chaseBufferDays")
    ) THEN
      RAISE EXCEPTION 'knotwork two-key: that request approved different approval rules' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."settingsRequestId" IS NOT NULL AND NEW."settingsRequestId" IS DISTINCT FROM OLD."settingsRequestId" THEN
    RAISE EXCEPTION 'knotwork two-key: a change_settings request is named only when it changes the approval rules' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Wedding_request_payload" BEFORE INSERT OR UPDATE ON "Wedding" FOR EACH ROW EXECUTE FUNCTION knotwork_wedding_request_payload();

-- FINDING 4 (D-195): a wedding is never deleted on its own. Deleting it and inserting another was a way to any date
-- and any approval rules with no request at all. The one exception is the whole workspace going (the export-and-delete
-- page, src/core/tenancy/delete.ts): the cascade reaches the wedding after the Org row is gone, as for guests.
CREATE FUNCTION knotwork_wedding_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Org" o WHERE o."id" = OLD."orgId") THEN
    RAISE EXCEPTION 'knotwork two-key: a wedding is never deleted on its own; it goes only with its workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "Wedding_delete_guard" BEFORE DELETE ON "Wedding" FOR EACH ROW EXECUTE FUNCTION knotwork_wedding_delete_guard();

-- FINDING 1 (D-190), PARTLY. Raw SQL can still write a request and mark it approved with the other partner's id as
-- the decider: the database has no identity it can trust for "who is asking" (the app connects as one role, and
-- anything the app could set for the session, the same raw SQL could set too). What the database can check, it now
-- does: the decider of an approval must be a partner (an owner) of that workspace at that moment, so a helper's id, a
-- stranger's or a made-up one no longer passes. Solo approvals have no decider and keep their own check (D-33).
CREATE FUNCTION knotwork_request_partner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'approved' AND NOT NEW."solo" AND NEW."deciderId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."orgId" = NEW."orgId" AND m."userId" = NEW."deciderId" AND m."role" = 'owner') THEN
    RAISE EXCEPTION 'knotwork two-key: only a partner of this workspace can approve a request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ConsentRequest_partner_guard" BEFORE UPDATE ON "ConsentRequest" FOR EACH ROW EXECUTE FUNCTION knotwork_request_partner_guard();
