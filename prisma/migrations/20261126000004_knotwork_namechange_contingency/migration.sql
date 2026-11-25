-- Knotwork Phase 4, P1-4 name-change sequence and P1-6 contingency decision trees (prisma/schema/knotwork.prisma).
-- Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code` proves it matches the schema.

-- CreateEnum
CREATE TYPE "NameStepStatus" AS ENUM ('started', 'done');

-- CreateEnum
CREATE TYPE "ContingencyItemKind" AS ENUM ('check', 'notify');

-- CreateTable
CREATE TABLE "NameChange" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NameChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NameChangeStep" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "nameChangeId" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "status" "NameStepStatus" NOT NULL,
    "completedOn" DATE,

    CONSTRAINT "NameChangeStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NameChangeArtifact" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "nameChangeId" UUID NOT NULL,
    "artifact" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NameChangeArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContingencyPlan" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "tree" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContingencyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContingencyRun" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "path" JSONB NOT NULL,
    "leaf" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "executedById" UUID,
    "executedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContingencyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContingencyItem" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ContingencyItemKind" NOT NULL,
    "text" TEXT NOT NULL,
    "vendorId" UUID,
    "doneOn" DATE,
    "doneById" UUID,

    CONSTRAINT "ContingencyItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NameChange_orgId_userId_key" ON "NameChange"("orgId", "userId");

-- CreateIndex
CREATE INDEX "NameChangeStep_orgId_idx" ON "NameChangeStep"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "NameChangeStep_nameChangeId_step_key" ON "NameChangeStep"("nameChangeId", "step");

-- CreateIndex
CREATE INDEX "NameChangeArtifact_orgId_idx" ON "NameChangeArtifact"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "NameChangeArtifact_nameChangeId_artifact_key" ON "NameChangeArtifact"("nameChangeId", "artifact");

-- CreateIndex
CREATE UNIQUE INDEX "ContingencyPlan_orgId_title_key" ON "ContingencyPlan"("orgId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "ContingencyRun_planId_key" ON "ContingencyRun"("planId");

-- CreateIndex
CREATE INDEX "ContingencyRun_orgId_idx" ON "ContingencyRun"("orgId");

-- CreateIndex
CREATE INDEX "ContingencyItem_orgId_idx" ON "ContingencyItem"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ContingencyItem_runId_position_key" ON "ContingencyItem"("runId", "position");

-- AddForeignKey
ALTER TABLE "NameChange" ADD CONSTRAINT "NameChange_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NameChangeStep" ADD CONSTRAINT "NameChangeStep_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NameChangeStep" ADD CONSTRAINT "NameChangeStep_nameChangeId_fkey" FOREIGN KEY ("nameChangeId") REFERENCES "NameChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NameChangeArtifact" ADD CONSTRAINT "NameChangeArtifact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NameChangeArtifact" ADD CONSTRAINT "NameChangeArtifact_nameChangeId_fkey" FOREIGN KEY ("nameChangeId") REFERENCES "NameChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContingencyPlan" ADD CONSTRAINT "ContingencyPlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContingencyRun" ADD CONSTRAINT "ContingencyRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContingencyRun" ADD CONSTRAINT "ContingencyRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ContingencyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContingencyItem" ADD CONSTRAINT "ContingencyItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContingencyItem" ADD CONSTRAINT "ContingencyItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ContingencyRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContingencyItem" ADD CONSTRAINT "ContingencyItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema: value checks, "a name change belongs to a partner", and "a row belongs to its parents'
-- workspace". The gating itself (prerequisites done, artifacts held) needs the rules files and lives in the store
-- (src/lib/knotwork/namechange/store.ts, over the pure workflow.ts); the database holds the shape it must leave.

-- Keys are the rules files' own shape: lowercase letters, digits and dashes.
ALTER TABLE "NameChange" ADD CONSTRAINT "NameChange_jurisdiction_check" CHECK ("jurisdiction" ~ '^[a-z0-9-]{1,40}$');
ALTER TABLE "NameChangeStep" ADD CONSTRAINT "NameChangeStep_step_check" CHECK ("step" ~ '^[a-z0-9-]{1,40}$');
ALTER TABLE "NameChangeArtifact" ADD CONSTRAINT "NameChangeArtifact_artifact_check" CHECK ("artifact" ~ '^[a-z0-9-]{1,40}$');
-- A finished step has the day it was finished; a started one has none.
ALTER TABLE "NameChangeStep" ADD CONSTRAINT "NameChangeStep_done_check" CHECK (("status" = 'done') = ("completedOn" IS NOT NULL));

ALTER TABLE "ContingencyPlan" ADD CONSTRAINT "ContingencyPlan_title_check" CHECK (length("title") BETWEEN 1 AND 80);
ALTER TABLE "ContingencyPlan" ADD CONSTRAINT "ContingencyPlan_tree_check" CHECK (jsonb_typeof("tree") = 'object' AND octet_length("tree"::text) <= 65536);
ALTER TABLE "ContingencyRun" ADD CONSTRAINT "ContingencyRun_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{16}$');
ALTER TABLE "ContingencyItem" ADD CONSTRAINT "ContingencyItem_text_check" CHECK (length("text") BETWEEN 1 AND 400 AND "position" >= 0);
ALTER TABLE "ContingencyItem" ADD CONSTRAINT "ContingencyItem_done_check" CHECK (("doneOn" IS NULL) = ("doneById" IS NULL));
ALTER TABLE "ContingencyItem" ADD CONSTRAINT "ContingencyItem_vendor_check" CHECK ("kind" = 'notify' OR "vendorId" IS NULL);

-- A name change belongs to a partner of its workspace (only a partner keeps one, D-114), and its steps and artifacts
-- to that name change's workspace. A run belongs to its plan's workspace; an item to its run's, and its vendor too.
CREATE FUNCTION knotwork_p14_p16_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'NameChange' THEN
    IF NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."orgId" = NEW."orgId" AND m."userId" = NEW."userId" AND m."role" = 'owner') THEN
      RAISE EXCEPTION 'knotwork name change: only a partner of the workspace has one' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'NameChangeStep' OR TG_TABLE_NAME = 'NameChangeArtifact' THEN
    IF NOT EXISTS (SELECT 1 FROM "NameChange" n WHERE n."id" = NEW."nameChangeId" AND n."orgId" = NEW."orgId") THEN
      RAISE EXCEPTION 'knotwork name change: a step or a document belongs to the same workspace as its name change' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'ContingencyRun' THEN
    IF NOT EXISTS (SELECT 1 FROM "ContingencyPlan" p WHERE p."id" = NEW."planId" AND p."orgId" = NEW."orgId") THEN
      RAISE EXCEPTION 'knotwork contingency: a run belongs to the same workspace as its plan' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "ContingencyRun" r WHERE r."id" = NEW."runId" AND r."orgId" = NEW."orgId")
       OR (NEW."vendorId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Vendor" v WHERE v."id" = NEW."vendorId" AND v."orgId" = NEW."orgId")) THEN
      RAISE EXCEPTION 'knotwork contingency: an item and its vendor belong to the same workspace as its run' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "NameChange_guard" BEFORE INSERT OR UPDATE ON "NameChange" FOR EACH ROW EXECUTE FUNCTION knotwork_p14_p16_guard();
CREATE TRIGGER "NameChangeStep_guard" BEFORE INSERT OR UPDATE ON "NameChangeStep" FOR EACH ROW EXECUTE FUNCTION knotwork_p14_p16_guard();
CREATE TRIGGER "NameChangeArtifact_guard" BEFORE INSERT OR UPDATE ON "NameChangeArtifact" FOR EACH ROW EXECUTE FUNCTION knotwork_p14_p16_guard();
CREATE TRIGGER "ContingencyRun_guard" BEFORE INSERT OR UPDATE ON "ContingencyRun" FOR EACH ROW EXECUTE FUNCTION knotwork_p14_p16_guard();
CREATE TRIGGER "ContingencyItem_guard" BEFORE INSERT OR UPDATE ON "ContingencyItem" FOR EACH ROW EXECUTE FUNCTION knotwork_p14_p16_guard();

-- A plan that was put into action keeps the tree it was run from: its run records the branch by index, so changing the
-- tree afterwards would make the record say something else (D-121).
CREATE FUNCTION knotwork_plan_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ContingencyRun" r WHERE r."planId" = OLD."id") AND NEW."tree" IS DISTINCT FROM OLD."tree" THEN
    RAISE EXCEPTION 'knotwork contingency: a plan that was put into action cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ContingencyPlan_frozen" BEFORE UPDATE ON "ContingencyPlan" FOR EACH ROW EXECUTE FUNCTION knotwork_plan_frozen();
