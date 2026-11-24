-- Knotwork Phase 4, P1-3 thank-you ledger (the gift log) and P1-8 link-out registry items
-- (prisma/schema/knotwork.prisma). Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code`
-- proves it matches the schema.

-- CreateTable
CREATE TABLE "GiftLog" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "householdId" UUID,
    "giverName" TEXT NOT NULL DEFAULT '',
    "what" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "acknowledgedOn" DATE,
    "acknowledgedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryLink" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "priceCents" INTEGER,
    "quantityWanted" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryClaim" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "claimedOn" DATE NOT NULL,
    "acknowledgedOn" DATE,
    "acknowledgedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftLog_orgId_idx" ON "GiftLog"("orgId");

-- CreateIndex
CREATE INDEX "GiftLog_householdId_idx" ON "GiftLog"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistryLink_orgId_title_key" ON "RegistryLink"("orgId", "title");

-- CreateIndex
CREATE INDEX "RegistryClaim_orgId_idx" ON "RegistryClaim"("orgId");

-- CreateIndex
CREATE INDEX "RegistryClaim_householdId_idx" ON "RegistryClaim"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistryClaim_linkId_householdId_key" ON "RegistryClaim"("linkId", "householdId");

-- AddForeignKey
ALTER TABLE "GiftLog" ADD CONSTRAINT "GiftLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftLog" ADD CONSTRAINT "GiftLog_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryLink" ADD CONSTRAINT "RegistryLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryClaim" ADD CONSTRAINT "RegistryClaim_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryClaim" ADD CONSTRAINT "RegistryClaim_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "RegistryLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryClaim" ADD CONSTRAINT "RegistryClaim_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema: value checks, "a claim never passes what is wanted", and "a row belongs to its parents'
-- workspace".

-- A logged gift is from a household or from a named person, never both and never neither; it says what it was.
ALTER TABLE "GiftLog" ADD CONSTRAINT "GiftLog_giver_check" CHECK (("householdId" IS NULL) <> ("giverName" = ''));
ALTER TABLE "GiftLog" ADD CONSTRAINT "GiftLog_what_check" CHECK (length("what") BETWEEN 1 AND 200 AND length("giverName") <= 120);
ALTER TABLE "GiftLog" ADD CONSTRAINT "GiftLog_ack_check" CHECK (("acknowledgedOn" IS NULL) = ("acknowledgedById" IS NULL));
ALTER TABLE "RegistryClaim" ADD CONSTRAINT "RegistryClaim_ack_check" CHECK (("acknowledgedOn" IS NULL) = ("acknowledgedById" IS NULL));

-- The database's half of the URL rule (registry/links.ts holds the whole of it): https, a host with no user or
-- password in front of it, no space or control character anywhere, and at most 2,000 characters.
ALTER TABLE "RegistryLink" ADD CONSTRAINT "RegistryLink_url_check" CHECK ("url" ~ '^https://[a-z0-9.-]+(:[0-9]+)?([/?#]|$)' AND "url" !~ '[[:space:][:cntrl:]\\]' AND length("url") <= 2000);
ALTER TABLE "RegistryLink" ADD CONSTRAINT "RegistryLink_text_check" CHECK (length("title") BETWEEN 1 AND 120 AND length("store") BETWEEN 1 AND 80);
ALTER TABLE "RegistryLink" ADD CONSTRAINT "RegistryLink_price_check" CHECK ("priceCents" IS NULL OR ("priceCents" > 0 AND "priceCents" <= 10000000));
ALTER TABLE "RegistryLink" ADD CONSTRAINT "RegistryLink_quantity_check" CHECK ("quantityWanted" BETWEEN 1 AND 99);
ALTER TABLE "RegistryClaim" ADD CONSTRAINT "RegistryClaim_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99);

-- A logged gift's household, and a claim's item and household, belong to the row's own workspace.
CREATE FUNCTION knotwork_thanks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'GiftLog' THEN
    IF NEW."householdId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Household" h WHERE h."id" = NEW."householdId" AND h."orgId" = NEW."orgId") THEN
      RAISE EXCEPTION 'knotwork thanks: the household must belong to the same workspace as the gift' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "RegistryLink" l WHERE l."id" = NEW."linkId" AND l."orgId" = NEW."orgId")
       OR NOT EXISTS (SELECT 1 FROM "Household" h WHERE h."id" = NEW."householdId" AND h."orgId" = NEW."orgId") THEN
      RAISE EXCEPTION 'knotwork registry: the item and the household must belong to the same workspace as the claim' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GiftLog_guard" BEFORE INSERT OR UPDATE ON "GiftLog" FOR EACH ROW EXECUTE FUNCTION knotwork_thanks_guard();
CREATE TRIGGER "RegistryClaim_guard" BEFORE INSERT OR UPDATE ON "RegistryClaim" FOR EACH ROW EXECUTE FUNCTION knotwork_thanks_guard();

-- Checked when the transaction commits: what households have claimed never passes what the couple wants. The store
-- serves claims one at a time under the wedding lock; this is the database refusing what that lock should prevent.
CREATE FUNCTION knotwork_claim_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  link_id uuid;
  wanted int;
  claimed bigint;
BEGIN
  IF TG_TABLE_NAME = 'RegistryLink' THEN
    link_id := NEW."id";
  ELSE
    link_id := NEW."linkId";
  END IF;
  SELECT l."quantityWanted" INTO wanted FROM "RegistryLink" l WHERE l."id" = link_id;
  IF NOT FOUND THEN
    RETURN NULL; -- gone with its workspace
  END IF;
  SELECT coalesce(sum(c."quantity"), 0) INTO claimed FROM "RegistryClaim" c WHERE c."linkId" = link_id;
  IF claimed > wanted THEN
    RAISE EXCEPTION 'knotwork registry: households cannot claim more than the couple wants' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "RegistryClaim_wanted_check" AFTER INSERT OR UPDATE ON "RegistryClaim" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_claim_check();
CREATE CONSTRAINT TRIGGER "RegistryLink_wanted_check" AFTER UPDATE ON "RegistryLink" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_claim_check();
