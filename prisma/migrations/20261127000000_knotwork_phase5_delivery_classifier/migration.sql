-- Knotwork Phase 5, slice E: delivery readiness (a channel per household, SMS consent, the opt-out, scheduled
-- reminders) and the photo classifier seam (D-135) (prisma/schema/knotwork.prisma).
-- Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code` proves it matches the schema.

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('email', 'sms', 'none');

-- CreateEnum
CREATE TYPE "PhotoClassifier" AS ENUM ('none', 'stub');

-- CreateEnum
CREATE TYPE "PhotoSuggestion" AS ENUM ('ok', 'review', 'hold');

-- AlterTable
ALTER TABLE "GuestPlan" ADD COLUMN     "autoReminders" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "remindVia" "ReminderChannel" NOT NULL DEFAULT 'email',
ADD COLUMN     "remindersStoppedAt" TIMESTAMPTZ(6),
ADD COLUMN     "smsConsentOn" DATE;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "suggestion" "PhotoSuggestion",
ADD COLUMN     "suggestionLabels" JSONB,
ADD COLUMN     "suggestionReason" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "PhotoEvent" ADD COLUMN     "classifier" "PhotoClassifier" NOT NULL DEFAULT 'none';

-- Not in Prisma's schema language: the database half of the rules (D-137, D-138).
-- A household is reminded by text message only with a recorded consent date and a phone number.
ALTER TABLE "Household" ADD CONSTRAINT "Household_sms_consent_check" CHECK ("remindVia" <> 'sms' OR ("smsConsentOn" IS NOT NULL AND "phone" <> ''));

-- A classifier's advice comes with its reason, and no advice comes with none.
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_suggestion_check" CHECK (("suggestion" IS NULL AND "suggestionReason" = '' AND "suggestionLabels" IS NULL) OR ("suggestion" IS NOT NULL AND "suggestionReason" <> ''));
