-- Knotwork D-33 (owner decision, 2026-11-24): while a workspace has exactly one partner and has never had two, that
-- partner's designated actions execute alone and are marked solo. Hand-written in Prisma's shape (D-04).

-- AlterTable
ALTER TABLE "ConsentRequest" ADD COLUMN     "solo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Wedding" ADD COLUMN     "pairedAt" TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema. An approved request now has either a second key, or the solo mark and no decider.
ALTER TABLE "ConsentRequest" DROP CONSTRAINT "ConsentRequest_decided_check";
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_decided_check" CHECK (
  "status" NOT IN ('approved', 'declined')
  OR ("decidedAt" IS NOT NULL AND ("deciderId" IS NOT NULL OR ("solo" AND "status" = 'approved')))
);
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_solo_check" CHECK (NOT "solo" OR ("status" = 'approved' AND "deciderId" IS NULL));

-- A request is born pending and unsigned; solo is only ever set by the pending → approved update below.
CREATE FUNCTION knotwork_request_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'pending' OR NEW."solo" OR NEW."deciderId" IS NOT NULL THEN
    RAISE EXCEPTION 'knotwork two-key: a request starts pending' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ConsentRequest_insert_guard" BEFORE INSERT ON "ConsentRequest" FOR EACH ROW EXECUTE FUNCTION knotwork_request_insert_guard();

-- The solo mark is true only if it is true: one owner in the workspace, that owner is the proposer, and the wedding
-- has never been paired. Otherwise as before: a decided request never changes, and what was proposed cannot be edited.
CREATE OR REPLACE FUNCTION knotwork_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'knotwork two-key: a decided request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" <> OLD."kind" OR NEW."payload" <> OLD."payload" OR NEW."proposerId" <> OLD."proposerId" OR NEW."orgId" <> OLD."orgId" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'knotwork two-key: what was proposed cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."solo" THEN
    IF (SELECT count(*) FROM "Membership" m WHERE m."orgId" = NEW."orgId" AND m."role" = 'owner') <> 1
       OR NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."orgId" = NEW."orgId" AND m."role" = 'owner' AND m."userId" = NEW."proposerId")
       OR NOT EXISTS (SELECT 1 FROM "Wedding" w WHERE w."orgId" = NEW."orgId" AND w."pairedAt" IS NULL) THEN
      RAISE EXCEPTION 'knotwork two-key: solo is only for a workspace with one partner that has never had two' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Wedding: once paired, always paired. (The date and settings rules are unchanged.)
CREATE FUNCTION knotwork_wedding_paired_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."pairedAt" IS NOT NULL AND NEW."pairedAt" IS DISTINCT FROM OLD."pairedAt" THEN
    RAISE EXCEPTION 'knotwork two-key: a paired wedding stays paired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Wedding_paired_guard" BEFORE UPDATE ON "Wedding" FOR EACH ROW EXECUTE FUNCTION knotwork_wedding_paired_guard();
