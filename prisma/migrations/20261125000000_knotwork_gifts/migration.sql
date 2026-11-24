-- Knotwork Phase 3, group gifting (PRD P0-5; prisma/schema/knotwork.prisma). Hand-written in Prisma's shape (D-04);
-- CI's `prisma migrate diff --exit-code` proves it matches the schema.

-- CreateEnum
CREATE TYPE "RegistryItemState" AS ENUM ('open', 'funded', 'closed_unfunded');

-- CreateEnum
CREATE TYPE "GiftEntryKind" AS ENUM ('contribution', 'excess_return', 'refund');

-- CreateTable
CREATE TABLE "RegistryItem" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "targetCents" INTEGER NOT NULL,
    "state" "RegistryItemState" NOT NULL DEFAULT 'open',
    "fundedOn" DATE,
    "closedOn" DATE,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftEntry" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "kind" "GiftEntryKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThankYou" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedOn" DATE,
    "acknowledgedById" UUID,

    CONSTRAINT "ThankYou_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistryItem_orgId_title_key" ON "RegistryItem"("orgId", "title");

-- CreateIndex
CREATE INDEX "GiftEntry_orgId_idx" ON "GiftEntry"("orgId");

-- CreateIndex
CREATE INDEX "GiftEntry_itemId_idx" ON "GiftEntry"("itemId");

-- CreateIndex
CREATE INDEX "GiftEntry_householdId_idx" ON "GiftEntry"("householdId");

-- CreateIndex
CREATE INDEX "ThankYou_orgId_idx" ON "ThankYou"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ThankYou_itemId_householdId_key" ON "ThankYou"("itemId", "householdId");

-- AddForeignKey
ALTER TABLE "RegistryItem" ADD CONSTRAINT "RegistryItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftEntry" ADD CONSTRAINT "GiftEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftEntry" ADD CONSTRAINT "GiftEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "RegistryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftEntry" ADD CONSTRAINT "GiftEntry_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThankYou" ADD CONSTRAINT "ThankYou_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThankYou" ADD CONSTRAINT "ThankYou_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "RegistryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThankYou" ADD CONSTRAINT "ThankYou_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema: value checks, the append-only ledger, and "the pot never passes its target".

ALTER TABLE "RegistryItem" ADD CONSTRAINT "RegistryItem_target_check" CHECK ("targetCents" > 0);
-- A funded item has the day it funded; a closed one the day it closed; an open one neither.
ALTER TABLE "RegistryItem" ADD CONSTRAINT "RegistryItem_funded_check" CHECK (("state" = 'funded') = ("fundedOn" IS NOT NULL));
ALTER TABLE "RegistryItem" ADD CONSTRAINT "RegistryItem_closed_check" CHECK (("state" = 'closed_unfunded') = ("closedOn" IS NOT NULL));
-- A contribution adds; an excess return and a refund give back. Never zero.
ALTER TABLE "GiftEntry" ADD CONSTRAINT "GiftEntry_sign_check" CHECK (("kind" = 'contribution' AND "amountCents" > 0) OR ("kind" IN ('excess_return', 'refund') AND "amountCents" < 0));
ALTER TABLE "ThankYou" ADD CONSTRAINT "ThankYou_ack_check" CHECK (("acknowledgedOn" IS NULL) = ("acknowledgedById" IS NULL));

-- The ledger is append-only: an entry is never changed and never deleted. A mistake is corrected by a new entry.
-- The one exception is the whole workspace going (the Org row is already gone when its rows cascade).
CREATE FUNCTION knotwork_gift_entry_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "Org" o WHERE o."id" = OLD."orgId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'knotwork gifts: the gift ledger is append-only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "GiftEntry_append_only" BEFORE UPDATE OR DELETE ON "GiftEntry" FOR EACH ROW EXECUTE FUNCTION knotwork_gift_entry_append_only();

-- An entry belongs to its item's and its household's workspace.
CREATE FUNCTION knotwork_gift_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RegistryItem" i WHERE i."id" = NEW."itemId" AND i."orgId" = NEW."orgId")
     OR NOT EXISTS (SELECT 1 FROM "Household" h WHERE h."id" = NEW."householdId" AND h."orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'knotwork gifts: the item and the household must belong to the same workspace as the entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GiftEntry_guard" BEFORE INSERT ON "GiftEntry" FOR EACH ROW EXECUTE FUNCTION knotwork_gift_entry_guard();

-- Checked when the transaction commits (a contribution over what remains is two entries: the whole offer, then the
-- excess back): a pot is never below zero or above its target, no household is ever below zero on an item, a funded
-- item holds exactly its target and a closed one holds nothing.
CREATE FUNCTION knotwork_gift_pot_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_id uuid;
  item "RegistryItem"%ROWTYPE;
  pot bigint;
BEGIN
  IF TG_TABLE_NAME = 'GiftEntry' THEN
    item_id := NEW."itemId";
  ELSE
    item_id := NEW."id";
  END IF;
  SELECT * INTO item FROM "RegistryItem" i WHERE i."id" = item_id;
  IF NOT FOUND THEN
    RETURN NULL; -- gone with its workspace
  END IF;
  SELECT coalesce(sum(e."amountCents"), 0) INTO pot FROM "GiftEntry" e WHERE e."itemId" = item_id;
  IF pot < 0 OR pot > item."targetCents" THEN
    RAISE EXCEPTION 'knotwork gifts: a pot must stay between zero and its target' USING ERRCODE = 'check_violation';
  END IF;
  IF item."state" = 'funded' AND pot <> item."targetCents" THEN
    RAISE EXCEPTION 'knotwork gifts: a funded item holds exactly its target' USING ERRCODE = 'check_violation';
  END IF;
  IF item."state" = 'closed_unfunded' AND pot <> 0 THEN
    RAISE EXCEPTION 'knotwork gifts: a closed item holds nothing; everything given is refunded' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "GiftEntry" e WHERE e."itemId" = item_id GROUP BY e."householdId" HAVING sum(e."amountCents") < 0) THEN
    RAISE EXCEPTION 'knotwork gifts: a household cannot be returned more than it gave' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "GiftEntry_pot_check" AFTER INSERT ON "GiftEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_gift_pot_check();
CREATE CONSTRAINT TRIGGER "RegistryItem_pot_check" AFTER INSERT OR UPDATE ON "RegistryItem" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_gift_pot_check();
