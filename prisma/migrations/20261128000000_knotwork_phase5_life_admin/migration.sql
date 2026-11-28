-- Knotwork Phase 5, slice F: the couple's life-admin mode after the wedding (the designated switch, D-143) and
-- recurring household tasks (a rule and a done-on log; next due is computed on read, D-145)
-- (prisma/schema/knotwork.prisma). Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code`
-- proves it matches the schema.

-- AlterEnum
ALTER TYPE "ConsentKind" ADD VALUE 'set_mode';

-- CreateEnum
CREATE TYPE "WeddingMode" AS ENUM ('planning', 'life');

-- CreateEnum
CREATE TYPE "RecurUnit" AS ENUM ('day', 'week', 'month', 'anniversary');

-- AlterTable
ALTER TABLE "Wedding" ADD COLUMN     "mode" "WeddingMode" NOT NULL DEFAULT 'planning',
ADD COLUMN     "modeChangedAt" TIMESTAMPTZ(6),
ADD COLUMN     "modeRequestId" UUID;

-- CreateTable
CREATE TABLE "RecurringTask" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "unit" "RecurUnit" NOT NULL,
    "every" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringDone" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "doneOn" DATE NOT NULL,
    "byId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringDone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringTask_orgId_idx" ON "RecurringTask"("orgId");

-- CreateIndex
CREATE INDEX "RecurringDone_orgId_idx" ON "RecurringDone"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringDone_taskId_doneOn_key" ON "RecurringDone"("taskId", "doneOn");

-- AddForeignKey
ALTER TABLE "Wedding" ADD CONSTRAINT "Wedding_modeRequestId_fkey" FOREIGN KEY ("modeRequestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringTask" ADD CONSTRAINT "RecurringTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringDone" ADD CONSTRAINT "RecurringDone_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringDone" ADD CONSTRAINT "RecurringDone_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "RecurringTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in Prisma's schema language: the database half of the rules.

-- RULE 2 (D-143): the mode is designated. A wedding is born in planning mode, and the mode changes only together with
-- a request not used before: an approved set_mode request of this workspace whose payload names the new mode. The date
-- of fact moves with it and never alone. (The "after the wedding day" rule is the executor's: it needs the app's
-- clock, which tests move; the database's clock is the real one.)
ALTER TABLE "Wedding" ADD CONSTRAINT "Wedding_mode_check" CHECK ("mode" = 'planning' OR "modeChangedAt" IS NOT NULL);

CREATE FUNCTION knotwork_wedding_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."mode" <> 'planning' OR NEW."modeRequestId" IS NOT NULL OR NEW."modeChangedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'knotwork two-key: a wedding starts in planning mode' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."mode" <> OLD."mode" THEN
    IF NEW."modeRequestId" IS NOT DISTINCT FROM OLD."modeRequestId" THEN
      RAISE EXCEPTION 'knotwork two-key: changing the mode needs its own approved set_mode request' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM knotwork_require_approved(NEW."modeRequestId", NEW."orgId", 'set_mode', 'changing the mode');
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."modeRequestId" AND r."payload"->>'to' = NEW."mode"::text) THEN
      RAISE EXCEPTION 'knotwork two-key: that request was for the other mode' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."modeChangedAt" IS NOT DISTINCT FROM OLD."modeChangedAt" THEN
      RAISE EXCEPTION 'knotwork two-key: a change of mode records when it happened' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."modeRequestId" IS DISTINCT FROM OLD."modeRequestId" OR NEW."modeChangedAt" IS DISTINCT FROM OLD."modeChangedAt" THEN
    RAISE EXCEPTION 'knotwork two-key: the mode''s request and date change only with the mode' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Wedding_mode_guard" BEFORE INSERT OR UPDATE ON "Wedding" FOR EACH ROW EXECUTE FUNCTION knotwork_wedding_mode_guard();

-- A recurring task is a rule in bounds (D-145): every 1 to 365 days, 1 to 52 weeks, 1 to 24 months, or yearly on the
-- anniversary (every = 1). One line of title, up to 120 characters; notes up to 2,000.
ALTER TABLE "RecurringTask" ADD CONSTRAINT "RecurringTask_rule_check" CHECK (
  ("unit" = 'day' AND "every" BETWEEN 1 AND 365) OR ("unit" = 'week' AND "every" BETWEEN 1 AND 52)
  OR ("unit" = 'month' AND "every" BETWEEN 1 AND 24) OR ("unit" = 'anniversary' AND "every" = 1)
);
ALTER TABLE "RecurringTask" ADD CONSTRAINT "RecurringTask_text_check" CHECK (length("title") BETWEEN 1 AND 120 AND length("notes") <= 2000);

-- A done-on row belongs to its task's workspace.
CREATE FUNCTION knotwork_recurring_done_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "RecurringTask" t WHERE t."id" = NEW."taskId" AND t."orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'knotwork life-admin: a done day belongs to a task of its own workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "RecurringDone_guard" BEFORE INSERT OR UPDATE ON "RecurringDone" FOR EACH ROW EXECUTE FUNCTION knotwork_recurring_done_guard();
