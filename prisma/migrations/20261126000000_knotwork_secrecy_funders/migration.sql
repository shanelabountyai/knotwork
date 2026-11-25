-- Knotwork Phase 4, slice A (prisma/schema/knotwork.prisma): P1-1 secrecy compartments on four item tables, and P1-2
-- the multi-funder family budget. Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code` proves
-- it matches the schema. ADR: docs/knotwork/adr/ADR-001-secrecy-compartments.md.

-- AlterEnum
ALTER TYPE "GrantScope" ADD VALUE 'funder';

-- AlterTable
ALTER TABLE "BudgetCategory" ADD COLUMN     "privateToId" UUID,
ADD COLUMN     "revealDays" INTEGER;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "privateToId" UUID,
ADD COLUMN     "revealDays" INTEGER;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "privateToId" UUID,
ADD COLUMN     "revealDays" INTEGER;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "privateToId" UUID,
ADD COLUMN     "revealDays" INTEGER;

-- CreateTable
CREATE TABLE "Funder" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "userId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Funder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunderPledge" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "funderId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunderPledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunderReceipt" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "pledgeId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "receivedOn" DATE NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunderReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunderAllocation" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "pledgeId" UUID NOT NULL,
    "expenseId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunderAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Funder_orgId_name_key" ON "Funder"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Funder_orgId_userId_key" ON "Funder"("orgId", "userId");

-- CreateIndex
CREATE INDEX "FunderPledge_orgId_idx" ON "FunderPledge"("orgId");

-- CreateIndex
CREATE INDEX "FunderPledge_categoryId_idx" ON "FunderPledge"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "FunderPledge_funderId_categoryId_key" ON "FunderPledge"("funderId", "categoryId");

-- CreateIndex
CREATE INDEX "FunderReceipt_orgId_idx" ON "FunderReceipt"("orgId");

-- CreateIndex
CREATE INDEX "FunderReceipt_pledgeId_idx" ON "FunderReceipt"("pledgeId");

-- CreateIndex
CREATE INDEX "FunderAllocation_orgId_idx" ON "FunderAllocation"("orgId");

-- CreateIndex
CREATE INDEX "FunderAllocation_expenseId_idx" ON "FunderAllocation"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "FunderAllocation_pledgeId_expenseId_key" ON "FunderAllocation"("pledgeId", "expenseId");

-- AddForeignKey
ALTER TABLE "Funder" ADD CONSTRAINT "Funder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderPledge" ADD CONSTRAINT "FunderPledge_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderPledge" ADD CONSTRAINT "FunderPledge_funderId_fkey" FOREIGN KEY ("funderId") REFERENCES "Funder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderPledge" ADD CONSTRAINT "FunderPledge_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderReceipt" ADD CONSTRAINT "FunderReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderReceipt" ADD CONSTRAINT "FunderReceipt_pledgeId_fkey" FOREIGN KEY ("pledgeId") REFERENCES "FunderPledge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderAllocation" ADD CONSTRAINT "FunderAllocation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderAllocation" ADD CONSTRAINT "FunderAllocation_pledgeId_fkey" FOREIGN KEY ("pledgeId") REFERENCES "FunderPledge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunderAllocation" ADD CONSTRAINT "FunderAllocation_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema. P1-1, the database half of ADR-001:
--   a reveal point is a whole number of days within ten years of the wedding, and only on a private item;
--   a designated action cannot be private: a booked or signed vendor, and an expense that went through consent, are shared;
--   an item is private only to someone who is a partner (an owner of the workspace) when it is marked.

ALTER TABLE "Task" ADD CONSTRAINT "Task_reveal_check" CHECK ("revealDays" IS NULL OR ("privateToId" IS NOT NULL AND "revealDays" BETWEEN -3650 AND 3650));
ALTER TABLE "BudgetCategory" ADD CONSTRAINT "BudgetCategory_reveal_check" CHECK ("revealDays" IS NULL OR ("privateToId" IS NOT NULL AND "revealDays" BETWEEN -3650 AND 3650));
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_reveal_check" CHECK ("revealDays" IS NULL OR ("privateToId" IS NOT NULL AND "revealDays" BETWEEN -3650 AND 3650));
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_reveal_check" CHECK ("revealDays" IS NULL OR ("privateToId" IS NOT NULL AND "revealDays" BETWEEN -3650 AND 3650));
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_designated_shared_check" CHECK ("privateToId" IS NULL OR ("status" <> 'booked' AND "contractSignedOn" IS NULL AND "bookedRequestId" IS NULL AND "contractRequestId" IS NULL));
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_designated_shared_check" CHECK ("privateToId" IS NULL OR "requestId" IS NULL);

CREATE FUNCTION knotwork_private_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."privateToId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."privateToId" IS DISTINCT FROM OLD."privateToId")
     AND NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."orgId" = NEW."orgId" AND m."userId" = NEW."privateToId" AND m."role" = 'owner') THEN
    RAISE EXCEPTION 'knotwork secrecy: only a partner of this workspace can keep an item private' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Task_private_owner" BEFORE INSERT OR UPDATE OF "privateToId" ON "Task" FOR EACH ROW EXECUTE FUNCTION knotwork_private_owner_guard();
CREATE TRIGGER "BudgetCategory_private_owner" BEFORE INSERT OR UPDATE OF "privateToId" ON "BudgetCategory" FOR EACH ROW EXECUTE FUNCTION knotwork_private_owner_guard();
CREATE TRIGGER "Expense_private_owner" BEFORE INSERT OR UPDATE OF "privateToId" ON "Expense" FOR EACH ROW EXECUTE FUNCTION knotwork_private_owner_guard();
CREATE TRIGGER "Vendor_private_owner" BEFORE INSERT OR UPDATE OF "privateToId" ON "Vendor" FOR EACH ROW EXECUTE FUNCTION knotwork_private_owner_guard();

-- P1-2. Amounts are positive integer cents; a pledge is at most $1,000,000.00 (D-95).
ALTER TABLE "FunderPledge" ADD CONSTRAINT "FunderPledge_amount_check" CHECK ("amountCents" > 0 AND "amountCents" <= 100000000);
ALTER TABLE "FunderReceipt" ADD CONSTRAINT "FunderReceipt_amount_check" CHECK ("amountCents" > 0);
ALTER TABLE "FunderAllocation" ADD CONSTRAINT "FunderAllocation_amount_check" CHECK ("amountCents" > 0);

-- Checked when the transaction commits: for every pledge touched, everything is in one workspace, received never
-- passes pledged and spent never passes received; an allocation pays an expense in the pledge's own category, and
-- no expense is paid from pledges for more than its amount.
CREATE FUNCTION knotwork_funding_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pledge_id uuid;
  p "FunderPledge"%ROWTYPE;
  received bigint;
  spent bigint;
BEGIN
  IF TG_TABLE_NAME = 'FunderPledge' THEN
    IF TG_OP = 'DELETE' THEN pledge_id := OLD."id"; ELSE pledge_id := NEW."id"; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN pledge_id := OLD."pledgeId"; ELSE pledge_id := NEW."pledgeId"; END IF;
  END IF;
  SELECT * INTO p FROM "FunderPledge" x WHERE x."id" = pledge_id;
  IF NOT FOUND THEN
    RETURN NULL; -- gone with its funder, its category or its workspace
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Funder" f WHERE f."id" = p."funderId" AND f."orgId" = p."orgId")
     OR NOT EXISTS (SELECT 1 FROM "BudgetCategory" c WHERE c."id" = p."categoryId" AND c."orgId" = p."orgId")
     OR EXISTS (SELECT 1 FROM "FunderReceipt" r WHERE r."pledgeId" = p."id" AND r."orgId" <> p."orgId")
     OR EXISTS (SELECT 1 FROM "FunderAllocation" a WHERE a."pledgeId" = p."id" AND a."orgId" <> p."orgId") THEN
    RAISE EXCEPTION 'knotwork funding: a pledge, its funder, its category, its receipts and its allocations belong to one workspace' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(r."amountCents"), 0) INTO received FROM "FunderReceipt" r WHERE r."pledgeId" = p."id";
  SELECT coalesce(sum(a."amountCents"), 0) INTO spent FROM "FunderAllocation" a WHERE a."pledgeId" = p."id";
  IF received > p."amountCents" THEN
    RAISE EXCEPTION 'knotwork funding: more received than pledged' USING ERRCODE = 'check_violation';
  END IF;
  IF spent > received THEN
    RAISE EXCEPTION 'knotwork funding: more spent than received' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "FunderAllocation" a JOIN "Expense" e ON e."id" = a."expenseId" WHERE a."pledgeId" = p."id" AND (e."categoryId" <> p."categoryId" OR e."orgId" <> p."orgId")) THEN
    RAISE EXCEPTION 'knotwork funding: a pledge pays only expenses in its own category' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "Expense" e WHERE e."id" IN (SELECT a."expenseId" FROM "FunderAllocation" a WHERE a."pledgeId" = p."id")
             AND e."amountCents" < (SELECT sum(b."amountCents") FROM "FunderAllocation" b WHERE b."expenseId" = e."id")) THEN
    RAISE EXCEPTION 'knotwork funding: an expense is paid from pledges for more than its amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "FunderPledge_check" AFTER INSERT OR UPDATE ON "FunderPledge" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_funding_check();
CREATE CONSTRAINT TRIGGER "FunderReceipt_check" AFTER INSERT OR UPDATE OR DELETE ON "FunderReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_funding_check();
CREATE CONSTRAINT TRIGGER "FunderAllocation_check" AFTER INSERT OR UPDATE ON "FunderAllocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knotwork_funding_check();
