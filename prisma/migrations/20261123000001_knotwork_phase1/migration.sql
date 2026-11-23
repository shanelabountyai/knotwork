-- Knotwork Phase 1 (prisma/schema/knotwork.prisma). Hand-written in Prisma's own shape (D-04: the sandbox could not run
-- the schema engine); CI's `prisma migrate diff --exit-code` step proves it matches the schema. The CHECK constraints
-- and triggers at the end are not expressible in the Prisma schema; Prisma's diff ignores them.

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('template', 'manual', 'payment', 'rsvp');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'done');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('considering', 'booked', 'dropped');

-- CreateEnum
CREATE TYPE "VendorCategory" AS ENUM ('venue', 'caterer', 'photographer', 'dj', 'florist', 'officiant', 'baker', 'attire', 'transport', 'planner', 'other');

-- CreateEnum
CREATE TYPE "FlagReason" AS ENUM ('date_moved', 'scope_changed');

-- CreateEnum
CREATE TYPE "ConsentKind" AS ENUM ('book_vendor', 'sign_contract', 'spend', 'change_date', 'change_settings', 'remove_guest');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('pending', 'approved', 'declined', 'withdrawn', 'expired');

-- CreateEnum
CREATE TYPE "GrantScope" AS ENUM ('schedule_edit', 'budget_view', 'budget_edit', 'vendors_view', 'vendors_edit', 'guests_edit');

-- CreateEnum
CREATE TYPE "BaselineKind" AS ENUM ('initial', 'move');

-- CreateTable
CREATE TABLE "Wedding" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dateRequestId" UUID,
    "timeZone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "spendThresholdCents" INTEGER NOT NULL DEFAULT 50000,
    "consentExpiryDays" INTEGER NOT NULL DEFAULT 7,
    "chaseBufferDays" INTEGER NOT NULL DEFAULT 14,
    "settingsRequestId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Wedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "kind" "TaskKind" NOT NULL DEFAULT 'manual',
    "leadDays" INTEGER NOT NULL,
    "bufferDays" INTEGER NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',
    "assigneeId" UUID,
    "completedOn" DATE,
    "vendorId" UUID,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDependency" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "dependsOnId" UUID NOT NULL,

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleBaseline" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "kind" "BaselineKind" NOT NULL,
    "fromDate" DATE,
    "toDate" DATE NOT NULL,
    "requestId" UUID,
    "snapshot" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetCategory" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "estimateCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "vendorId" UUID,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "requestId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetSnapshot" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "totals" JSONB NOT NULL,
    "takenById" UUID,
    "takenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "VendorCategory" NOT NULL,
    "contactName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" "VendorStatus" NOT NULL DEFAULT 'considering',
    "bookedRequestId" UUID,
    "contractTotalCents" INTEGER,
    "contractSignedOn" DATE,
    "contractRequestId" UUID,
    "deliverables" TEXT NOT NULL DEFAULT '',
    "arriveMin" INTEGER,
    "departMin" INTEGER,
    "countEstimate" INTEGER,
    "countDueDaysBefore" INTEGER,
    "onSite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorPayment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "dueDaysBefore" INTEGER NOT NULL,
    "taskId" UUID NOT NULL,
    "paidOn" DATE,
    "expenseId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorFlag" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "reason" "FlagReason" NOT NULL,
    "detail" JSONB NOT NULL,
    "raisedById" UUID,
    "raisedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackById" UUID,
    "ackAt" TIMESTAMPTZ(6),
    "ackNote" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "VendorFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorBrief" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "generatedById" UUID,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRequest" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "kind" "ConsentKind" NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "proposerId" UUID NOT NULL,
    "proposedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "deciderId" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "declineReason" TEXT NOT NULL DEFAULT '',
    "executedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ConsentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelperGrant" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scope" "GrantScope" NOT NULL,
    "grantedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelperGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wedding_orgId_key" ON "Wedding"("orgId");

-- CreateIndex
CREATE INDEX "Task_orgId_idx" ON "Task"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_orgId_key_key" ON "Task"("orgId", "key");

-- CreateIndex
CREATE INDEX "TaskDependency_orgId_idx" ON "TaskDependency"("orgId");

-- CreateIndex
CREATE INDEX "TaskDependency_dependsOnId_idx" ON "TaskDependency"("dependsOnId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDependency_taskId_dependsOnId_key" ON "TaskDependency"("taskId", "dependsOnId");

-- CreateIndex
CREATE INDEX "ScheduleBaseline_orgId_createdAt_idx" ON "ScheduleBaseline"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetCategory_orgId_name_key" ON "BudgetCategory"("orgId", "name");

-- CreateIndex
CREATE INDEX "Expense_orgId_idx" ON "Expense"("orgId");

-- CreateIndex
CREATE INDEX "Expense_categoryId_idx" ON "Expense"("categoryId");

-- CreateIndex
CREATE INDEX "BudgetSnapshot_orgId_takenAt_idx" ON "BudgetSnapshot"("orgId", "takenAt");

-- CreateIndex
CREATE INDEX "Vendor_orgId_idx" ON "Vendor"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayment_taskId_key" ON "VendorPayment"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayment_expenseId_key" ON "VendorPayment"("expenseId");

-- CreateIndex
CREATE INDEX "VendorPayment_orgId_idx" ON "VendorPayment"("orgId");

-- CreateIndex
CREATE INDEX "VendorPayment_vendorId_idx" ON "VendorPayment"("vendorId");

-- CreateIndex
CREATE INDEX "VendorFlag_orgId_ackAt_idx" ON "VendorFlag"("orgId", "ackAt");

-- CreateIndex
CREATE INDEX "VendorFlag_vendorId_idx" ON "VendorFlag"("vendorId");

-- CreateIndex
CREATE INDEX "VendorBrief_orgId_idx" ON "VendorBrief"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorBrief_vendorId_version_key" ON "VendorBrief"("vendorId", "version");

-- CreateIndex
CREATE INDEX "ConsentRequest_orgId_status_idx" ON "ConsentRequest"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HelperGrant_orgId_userId_scope_key" ON "HelperGrant"("orgId", "userId", "scope");

-- AddForeignKey
ALTER TABLE "Wedding" ADD CONSTRAINT "Wedding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wedding" ADD CONSTRAINT "Wedding_dateRequestId_fkey" FOREIGN KEY ("dateRequestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wedding" ADD CONSTRAINT "Wedding_settingsRequestId_fkey" FOREIGN KEY ("settingsRequestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleBaseline" ADD CONSTRAINT "ScheduleBaseline_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleBaseline" ADD CONSTRAINT "ScheduleBaseline_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetCategory" ADD CONSTRAINT "BudgetCategory_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BudgetCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetSnapshot" ADD CONSTRAINT "BudgetSnapshot_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_bookedRequestId_fkey" FOREIGN KEY ("bookedRequestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_contractRequestId_fkey" FOREIGN KEY ("contractRequestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorFlag" ADD CONSTRAINT "VendorFlag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorFlag" ADD CONSTRAINT "VendorFlag_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBrief" ADD CONSTRAINT "VendorBrief_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBrief" ADD CONSTRAINT "VendorBrief_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelperGrant" ADD CONSTRAINT "HelperGrant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelperGrant" ADD CONSTRAINT "HelperGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema: value checks, and the database's half of rule 2 (designated actions need an approved request).

ALTER TABLE "Wedding" ADD CONSTRAINT "Wedding_settings_check" CHECK ("spendThresholdCents" >= 0 AND "consentExpiryDays" >= 1 AND "chaseBufferDays" >= 0);
ALTER TABLE "Task" ADD CONSTRAINT "Task_days_check" CHECK ("leadDays" >= 0 AND "bufferDays" >= 0);
ALTER TABLE "Task" ADD CONSTRAINT "Task_done_check" CHECK (("status" = 'done') = ("completedOn" IS NOT NULL));
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_not_self_check" CHECK ("taskId" <> "dependsOnId");
ALTER TABLE "ScheduleBaseline" ADD CONSTRAINT "ScheduleBaseline_move_request_check" CHECK ("kind" = 'initial' OR "requestId" IS NOT NULL);
ALTER TABLE "BudgetCategory" ADD CONSTRAINT "BudgetCategory_estimate_check" CHECK ("estimateCents" >= 0);
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_amount_check" CHECK ("amountCents" > 0);
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_amount_check" CHECK ("amountCents" > 0 AND "dueDaysBefore" >= 0);
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_times_check" CHECK (("arriveMin" IS NULL OR "arriveMin" BETWEEN 0 AND 1439) AND ("departMin" IS NULL OR "departMin" BETWEEN 0 AND 1439) AND ("countEstimate" IS NULL OR "countEstimate" >= 0) AND ("countDueDaysBefore" IS NULL OR "countDueDaysBefore" >= 0) AND ("contractTotalCents" IS NULL OR "contractTotalCents" >= 0));
-- Two keys: an approved request has a decider who is not its proposer, and was executed at the same moment.
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_two_key_check" CHECK ("deciderId" IS NULL OR "deciderId" <> "proposerId");
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_decided_check" CHECK ("status" NOT IN ('approved', 'declined') OR ("deciderId" IS NOT NULL AND "decidedAt" IS NOT NULL));
ALTER TABLE "ConsentRequest" ADD CONSTRAINT "ConsentRequest_executed_check" CHECK (("status" = 'approved') = ("executedAt" IS NOT NULL));

-- An approved request of the right kind, in the same org, that names this row. Raises otherwise.
CREATE FUNCTION knotwork_require_approved(req uuid, org uuid, k "ConsentKind", what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF req IS NULL OR NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = req AND r."orgId" = org AND r."kind" = k AND r."status" = 'approved') THEN
    RAISE EXCEPTION 'knotwork two-key: % needs an approved % request', what, k USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- A decided request never changes again, and a pending one only changes its decision fields.
CREATE FUNCTION knotwork_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'knotwork two-key: a decided request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" <> OLD."kind" OR NEW."payload" <> OLD."payload" OR NEW."proposerId" <> OLD."proposerId" OR NEW."orgId" <> OLD."orgId" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'knotwork two-key: what was proposed cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ConsentRequest_guard" BEFORE UPDATE ON "ConsentRequest" FOR EACH ROW EXECUTE FUNCTION knotwork_request_guard();

-- Vendor: booked and contract-signed are designated.
CREATE FUNCTION knotwork_vendor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'booked' AND (TG_OP = 'INSERT' OR OLD."status" <> 'booked' OR NEW."bookedRequestId" IS DISTINCT FROM OLD."bookedRequestId") THEN
    PERFORM knotwork_require_approved(NEW."bookedRequestId", NEW."orgId", 'book_vendor', 'booking a vendor');
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."bookedRequestId" AND r."payload"->>'vendorId' = NEW."id"::text) THEN
      RAISE EXCEPTION 'knotwork two-key: that request is for another vendor' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."contractSignedOn" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."contractSignedOn" IS NULL OR NEW."contractSignedOn" <> OLD."contractSignedOn" OR NEW."contractRequestId" IS DISTINCT FROM OLD."contractRequestId") THEN
    PERFORM knotwork_require_approved(NEW."contractRequestId", NEW."orgId", 'sign_contract', 'signing a contract');
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."contractRequestId" AND r."payload"->>'vendorId' = NEW."id"::text) THEN
      RAISE EXCEPTION 'knotwork two-key: that request is for another vendor' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Vendor_guard" BEFORE INSERT OR UPDATE ON "Vendor" FOR EACH ROW EXECUTE FUNCTION knotwork_vendor_guard();

-- Wedding: after creation, the date and the three settings are designated. Each change names a request not used before.
CREATE FUNCTION knotwork_wedding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."date" <> OLD."date" THEN
    IF NEW."dateRequestId" IS NOT DISTINCT FROM OLD."dateRequestId" THEN
      RAISE EXCEPTION 'knotwork two-key: changing the date needs its own approved change_date request' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM knotwork_require_approved(NEW."dateRequestId", NEW."orgId", 'change_date', 'changing the date');
  END IF;
  IF NEW."spendThresholdCents" <> OLD."spendThresholdCents" OR NEW."consentExpiryDays" <> OLD."consentExpiryDays" OR NEW."chaseBufferDays" <> OLD."chaseBufferDays" THEN
    IF NEW."settingsRequestId" IS NOT DISTINCT FROM OLD."settingsRequestId" THEN
      RAISE EXCEPTION 'knotwork two-key: changing the approval rules needs its own approved change_settings request' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM knotwork_require_approved(NEW."settingsRequestId", NEW."orgId", 'change_settings', 'changing the approval rules');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Wedding_guard" BEFORE UPDATE ON "Wedding" FOR EACH ROW EXECUTE FUNCTION knotwork_wedding_guard();

-- Expense: strictly over the wedding's spend threshold is designated. An expense never changes amount afterwards.
CREATE FUNCTION knotwork_expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  threshold integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."amountCents" <> OLD."amountCents" OR NEW."requestId" IS DISTINCT FROM OLD."requestId" OR NEW."orgId" <> OLD."orgId" THEN
      RAISE EXCEPTION 'knotwork two-key: an expense amount cannot be edited; add a new expense' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT w."spendThresholdCents" INTO threshold FROM "Wedding" w WHERE w."orgId" = NEW."orgId";
  IF threshold IS NULL THEN
    RAISE EXCEPTION 'knotwork: an expense needs a wedding' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amountCents" > threshold THEN
    PERFORM knotwork_require_approved(NEW."requestId", NEW."orgId", 'spend', 'a spend over the threshold');
    IF EXISTS (SELECT 1 FROM "Expense" e WHERE e."requestId" = NEW."requestId") THEN
      RAISE EXCEPTION 'knotwork two-key: that request has already been spent' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."requestId" AND (r."payload"->>'amountCents')::integer = NEW."amountCents") THEN
      RAISE EXCEPTION 'knotwork two-key: that request approved a different amount' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Expense_guard" BEFORE INSERT OR UPDATE ON "Expense" FOR EACH ROW EXECUTE FUNCTION knotwork_expense_guard();
