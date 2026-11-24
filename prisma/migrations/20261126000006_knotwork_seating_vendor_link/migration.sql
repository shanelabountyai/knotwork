-- Knotwork Phase 4, P1-5 seating chart and the vendor read-only link (D-42) (prisma/schema/knotwork.prisma).
-- Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code` proves it matches the schema.

-- CreateEnum
CREATE TYPE "SeatingRuleKind" AS ENUM ('apart', 'together');

-- AlterTable
ALTER TABLE "GuestPlan" ADD COLUMN     "seatPending" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "linkTokenHash" TEXT,
ADD COLUMN     "linkTokenSealed" TEXT;

-- CreateTable
CREATE TABLE "SeatingTable" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeatingTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatingRule" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "kind" "SeatingRuleKind" NOT NULL,
    "hard" BOOLEAN NOT NULL,
    "guestAId" UUID NOT NULL,
    "guestBId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeatingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_linkTokenHash_key" ON "Vendor"("linkTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "SeatingTable_orgId_name_key" ON "SeatingTable"("orgId", "name");

-- CreateIndex
CREATE INDEX "SeatingRule_orgId_idx" ON "SeatingRule"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SeatingRule_guestAId_guestBId_key" ON "SeatingRule"("guestAId", "guestBId");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_guestId_key" ON "Seat"("guestId");

-- CreateIndex
CREATE INDEX "Seat_orgId_idx" ON "Seat"("orgId");

-- CreateIndex
CREATE INDEX "Seat_tableId_idx" ON "Seat"("tableId");

-- AddForeignKey
ALTER TABLE "SeatingTable" ADD CONSTRAINT "SeatingTable_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatingRule" ADD CONSTRAINT "SeatingRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatingRule" ADD CONSTRAINT "SeatingRule_guestAId_fkey" FOREIGN KEY ("guestAId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatingRule" ADD CONSTRAINT "SeatingRule_guestBId_fkey" FOREIGN KEY ("guestBId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "SeatingTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema: value checks, "a row belongs to its parents' workspace", and "a table never holds more
-- than it seats". The search itself lives in src/lib/knotwork/seating/engine.ts; the database holds the shape it must
-- leave.

ALTER TABLE "SeatingTable" ADD CONSTRAINT "SeatingTable_name_check" CHECK (length("name") BETWEEN 1 AND 40);
ALTER TABLE "SeatingTable" ADD CONSTRAINT "SeatingTable_capacity_check" CHECK ("capacity" BETWEEN 1 AND 30);
-- One row per pair, the smaller id first (so no guest is paired with themself, and a pair cannot be stored twice).
ALTER TABLE "SeatingRule" ADD CONSTRAINT "SeatingRule_pair_check" CHECK ("guestAId" < "guestBId");
-- D-42: a vendor link is 32 random bytes; its sha256 is 64 hex characters, and the sealed copy comes with it.
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_link_check" CHECK (("linkTokenHash" IS NULL) = ("linkTokenSealed" IS NULL) AND ("linkTokenHash" IS NULL OR "linkTokenHash" ~ '^[0-9a-f]{64}$'));

-- A rule's two guests, and a seat's guest and table, belong to the row's own workspace.
CREATE FUNCTION knotwork_p15_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'SeatingRule' THEN
    IF (SELECT count(*) FROM "Guest" g WHERE g."id" IN (NEW."guestAId", NEW."guestBId") AND g."orgId" = NEW."orgId") <> 2 THEN
      RAISE EXCEPTION 'knotwork seating: a rule pairs two guests of its own workspace' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "Guest" g WHERE g."id" = NEW."guestId" AND g."orgId" = NEW."orgId")
       OR NOT EXISTS (SELECT 1 FROM "SeatingTable" t WHERE t."id" = NEW."tableId" AND t."orgId" = NEW."orgId") THEN
      RAISE EXCEPTION 'knotwork seating: a seat, its guest and its table belong to one workspace' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SeatingRule_guard" BEFORE INSERT OR UPDATE ON "SeatingRule" FOR EACH ROW EXECUTE FUNCTION knotwork_p15_guard();
CREATE TRIGGER "Seat_guard" BEFORE INSERT OR UPDATE ON "Seat" FOR EACH ROW EXECUTE FUNCTION knotwork_p15_guard();

-- At commit: no table holds more seats than it has. Deferred, so a regenerate can clear and refill in one transaction.
CREATE FUNCTION knotwork_table_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t UUID;
BEGIN
  IF TG_TABLE_NAME = 'Seat' THEN
    t := NEW."tableId";
  ELSE
    t := NEW."id";
  END IF;
  IF (SELECT count(*) FROM "Seat" s WHERE s."tableId" = t) > (SELECT st."capacity" FROM "SeatingTable" st WHERE st."id" = t) THEN
    RAISE EXCEPTION 'knotwork seating: a table holds more guests than it seats' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Seat_capacity" AFTER INSERT OR UPDATE ON "Seat" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_table_capacity();
CREATE CONSTRAINT TRIGGER "SeatingTable_capacity" AFTER UPDATE ON "SeatingTable" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_table_capacity();
