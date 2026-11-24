-- Knotwork review 2026-11-24 (D-56): the pairing latch (D-33) is set at the source. Until now "Wedding"."pairedAt"
-- was set by the next wedding page load or proposal, so a second partner who had joined but not yet opened a wedding
-- page could be removed and solo mode came back. Now the database sets it the moment a workspace has two partners,
-- however the second one arrived (invite, role change, SSO), and writes the change-log line itself.
-- Triggers only; nothing here is in the Prisma schema. Hand-written (D-04).

-- Fires for every membership that becomes an owner. Takes the org row lock (the same lock the template's member
-- changes take), so two partners arriving at once, or one arriving while the wedding is being created, are counted
-- one after the other and neither is missed.
CREATE FUNCTION knotwork_pairing_latch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w RECORD;
BEGIN
  IF NEW."role" <> 'owner' THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM "Org" o WHERE o."id" = NEW."orgId" FOR UPDATE;
  IF (SELECT count(*) FROM "Membership" m WHERE m."orgId" = NEW."orgId" AND m."role" = 'owner') < 2 THEN
    RETURN NULL;
  END IF;
  FOR w IN UPDATE "Wedding" SET "pairedAt" = CURRENT_TIMESTAMP WHERE "orgId" = NEW."orgId" AND "pairedAt" IS NULL RETURNING "id", "title" LOOP
    INSERT INTO "AuditEvent" ("orgId", "actorUserId", "action", "targetType", "targetId", "data")
    VALUES (NEW."orgId", NULL, 'knotwork.wedding.paired', 'wedding', w."id"::text,
            jsonb_build_object('label', w."title", 'before', jsonb_build_object('paired', false), 'after', jsonb_build_object('paired', true)));
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "Membership_pairing_latch" AFTER INSERT OR UPDATE OF "role" ON "Membership" FOR EACH ROW EXECUTE FUNCTION knotwork_pairing_latch();

-- A wedding created when the workspace already has two partners is born paired.
CREATE FUNCTION knotwork_wedding_born_paired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Org" o WHERE o."id" = NEW."orgId" FOR UPDATE;
  IF NEW."pairedAt" IS NULL AND (SELECT count(*) FROM "Membership" m WHERE m."orgId" = NEW."orgId" AND m."role" = 'owner') >= 2 THEN
    NEW."pairedAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Wedding_born_paired" BEFORE INSERT ON "Wedding" FOR EACH ROW EXECUTE FUNCTION knotwork_wedding_born_paired();
