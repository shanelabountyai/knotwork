-- Knotwork Phase 2: guest engine and tiered backfill (prisma/schema/knotwork.prisma). Hand-written in Prisma's shape
-- (D-04); CI's `prisma migrate diff --exit-code` proves it matches the schema.

-- CreateEnum
CREATE TYPE "GuestList" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "HouseholdState" AS ENUM ('queued', 'invited', 'regrets');

-- CreateEnum
CREATE TYPE "AgeGroup" AS ENUM ('adult', 'child', 'infant');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('none', 'dating', 'long_distance', 'engaged', 'married');

-- CreateEnum
CREATE TYPE "RsvpStatus" AS ENUM ('pending', 'attending', 'declined');

-- CreateEnum
CREATE TYPE "PlusOneOverride" AS ENUM ('grant', 'deny');

-- CreateEnum
CREATE TYPE "ChaseKind" AS ENUM ('reminder', 'call');

-- CreateTable
CREATE TABLE "GuestPlan" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "cap" INTEGER NOT NULL DEFAULT 100,
    "venueMin" INTEGER,
    "venueMax" INTEGER,
    "perHeadCents" INTEGER NOT NULL DEFAULT 0,
    "kidsMealCents" INTEGER NOT NULL DEFAULT 0,
    "vendorMealCents" INTEGER NOT NULL DEFAULT 0,
    "lockoutDays" INTEGER NOT NULL DEFAULT 42,
    "minBatchSeats" INTEGER NOT NULL DEFAULT 4,
    "mealOptions" TEXT[],
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GuestPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Household" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "address1" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT '',
    "postal" TEXT NOT NULL DEFAULT '',
    "list" "GuestList" NOT NULL DEFAULT 'A',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "state" "HouseholdState" NOT NULL DEFAULT 'queued',
    "invitedOn" DATE,
    "waveId" UUID,
    "saveTheDateSentOn" DATE,
    "plusOneOverride" "PlusOneOverride",
    "plusOneNote" TEXT NOT NULL DEFAULT '',
    "rsvpTokenHash" TEXT,
    "rsvpTokenSealed" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guest" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ageGroup" "AgeGroup" NOT NULL DEFAULT 'adult',
    "partnerStatus" "PartnerStatus" NOT NULL DEFAULT 'none',
    "inWeddingParty" BOOLEAN NOT NULL DEFAULT false,
    "isPlusOne" BOOLEAN NOT NULL DEFAULT false,
    "rsvp" "RsvpStatus" NOT NULL DEFAULT 'pending',
    "meal" TEXT,
    "dietary" TEXT[],
    "accessibility" TEXT[],
    "songRequest" TEXT NOT NULL DEFAULT '',
    "privateNote" TEXT NOT NULL DEFAULT '',
    "respondedAt" TIMESTAMPTZ(6),
    "removedAt" TIMESTAMPTZ(6),
    "removedRequestId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteWave" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "list" "GuestList" NOT NULL,
    "releasedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedById" UUID,
    "householdCount" INTEGER NOT NULL,
    "seatCount" INTEGER NOT NULL,

    CONSTRAINT "InviteWave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeadcountDelta" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "deltaSeats" INTEGER NOT NULL,
    "deltaCents" INTEGER NOT NULL,
    "attendingAfter" INTEGER NOT NULL,
    "costAfterCents" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeadcountDelta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChaseEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "kind" "ChaseKind" NOT NULL,
    "step" INTEGER NOT NULL,
    "byId" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoNotPlay" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL DEFAULT '',
    "addedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoNotPlay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestPlan_orgId_key" ON "GuestPlan"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Household_rsvpTokenHash_key" ON "Household"("rsvpTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Household_orgId_name_key" ON "Household"("orgId", "name");

-- CreateIndex
CREATE INDEX "Guest_orgId_idx" ON "Guest"("orgId");

-- CreateIndex
CREATE INDEX "Guest_householdId_idx" ON "Guest"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "InviteWave_orgId_number_key" ON "InviteWave"("orgId", "number");

-- CreateIndex
CREATE INDEX "HeadcountDelta_orgId_at_idx" ON "HeadcountDelta"("orgId", "at");

-- CreateIndex
CREATE INDEX "ChaseEvent_orgId_idx" ON "ChaseEvent"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ChaseEvent_householdId_kind_step_key" ON "ChaseEvent"("householdId", "kind", "step");

-- CreateIndex
CREATE UNIQUE INDEX "DoNotPlay_orgId_title_artist_key" ON "DoNotPlay"("orgId", "title", "artist");

-- AddForeignKey
ALTER TABLE "GuestPlan" ADD CONSTRAINT "GuestPlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Household" ADD CONSTRAINT "Household_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Household" ADD CONSTRAINT "Household_waveId_fkey" FOREIGN KEY ("waveId") REFERENCES "InviteWave"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_removedRequestId_fkey" FOREIGN KEY ("removedRequestId") REFERENCES "ConsentRequest"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteWave" ADD CONSTRAINT "InviteWave_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeadcountDelta" ADD CONSTRAINT "HeadcountDelta_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChaseEvent" ADD CONSTRAINT "ChaseEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChaseEvent" ADD CONSTRAINT "ChaseEvent_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoNotPlay" ADD CONSTRAINT "DoNotPlay_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema: value checks, and rule 2 for the guest list (a removal needs an approved request).

ALTER TABLE "GuestPlan" ADD CONSTRAINT "GuestPlan_values_check" CHECK ("cap" >= 0 AND "perHeadCents" >= 0 AND "kidsMealCents" >= 0 AND "vendorMealCents" >= 0 AND "lockoutDays" >= 0 AND "minBatchSeats" >= 1 AND ("venueMin" IS NULL OR "venueMin" >= 0) AND ("venueMax" IS NULL OR "venueMax" >= 0) AND ("venueMin" IS NULL OR "venueMax" IS NULL OR "venueMin" <= "venueMax"));
-- An invited household has its invite date; a queued or regrets one has none.
ALTER TABLE "Household" ADD CONSTRAINT "Household_invited_check" CHECK (("state" = 'invited') = ("invitedOn" IS NOT NULL));
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_responded_check" CHECK (("rsvp" = 'pending') = ("respondedAt" IS NULL));
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_removed_check" CHECK (("removedAt" IS NULL) = ("removedRequestId" IS NULL));

-- A guest is never deleted, and is removed only by an approved remove_guest request that names them. Once removed,
-- stays removed. The one exception to "never deleted" is the whole workspace going (the Org row is already gone).
CREATE FUNCTION knotwork_guest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "Org" o WHERE o."id" = OLD."orgId") THEN
      RAISE EXCEPTION 'knotwork two-key: a guest or household is never deleted; remove the guest with an approved request' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."removedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'knotwork two-key: a guest cannot be added already removed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."removedAt" IS NOT NULL AND (NEW."removedAt" IS DISTINCT FROM OLD."removedAt" OR NEW."removedRequestId" IS DISTINCT FROM OLD."removedRequestId") THEN
    RAISE EXCEPTION 'knotwork two-key: a removed guest stays removed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."removedAt" IS NOT NULL AND OLD."removedAt" IS NULL THEN
    PERFORM knotwork_require_approved(NEW."removedRequestId", NEW."orgId", 'remove_guest', 'removing a guest');
    IF NOT EXISTS (SELECT 1 FROM "ConsentRequest" r WHERE r."id" = NEW."removedRequestId" AND r."payload"->'guestIds' ? NEW."id"::text) THEN
      RAISE EXCEPTION 'knotwork two-key: that request is for another guest' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Guest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Guest" FOR EACH ROW EXECUTE FUNCTION knotwork_guest_guard();

CREATE FUNCTION knotwork_household_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Org" o WHERE o."id" = OLD."orgId") THEN
    RAISE EXCEPTION 'knotwork two-key: a guest or household is never deleted; remove the guest with an approved request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "Household_guard" BEFORE DELETE ON "Household" FOR EACH ROW EXECUTE FUNCTION knotwork_household_guard();
