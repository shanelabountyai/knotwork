-- Knotwork Phase 3, the photo wall and contract attachments (PRD P0-6, D-39; prisma/schema/knotwork.prisma).
-- Hand-written in Prisma's shape (D-04); CI's `prisma migrate diff --exit-code` proves it matches the schema.

-- CreateEnum
CREATE TYPE "PhotoMode" AS ENUM ('pre', 'post');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('pending', 'live', 'removed');

-- CreateEnum
CREATE TYPE "PhotoBlobKind" AS ENUM ('full', 'display', 'thumb');

-- AlterEnum
ALTER TYPE "GrantScope" ADD VALUE 'photos_moderate';

-- CreateTable
CREATE TABLE "PhotoEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "PhotoMode" NOT NULL DEFAULT 'post',
    "uploadTokenHash" TEXT NOT NULL,
    "uploadTokenSealed" TEXT NOT NULL,
    "uploadsOpen" BOOLEAN NOT NULL DEFAULT true,
    "uploadDays" INTEGER NOT NULL DEFAULT 7,
    "retentionDays" INTEGER NOT NULL DEFAULT 365,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotoDevice" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockedAt" TIMESTAMPTZ(6),
    "blockedById" UUID,

    CONSTRAINT "PhotoDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "uploaderName" TEXT NOT NULL DEFAULT '',
    "caption" TEXT NOT NULL DEFAULT '',
    "status" "PhotoStatus" NOT NULL,
    "removedFrom" "PhotoStatus",
    "hiddenFromWall" BOOLEAN NOT NULL DEFAULT false,
    "hiddenFromAlbum" BOOLEAN NOT NULL DEFAULT false,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotoBlob" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "photoId" UUID NOT NULL,
    "kind" "PhotoBlobKind" NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,

    CONSTRAINT "PhotoBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAttachment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhotoEvent_uploadTokenHash_key" ON "PhotoEvent"("uploadTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PhotoEvent_orgId_name_key" ON "PhotoEvent"("orgId", "name");

-- CreateIndex
CREATE INDEX "PhotoDevice_orgId_idx" ON "PhotoDevice"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PhotoDevice_eventId_tokenHash_key" ON "PhotoDevice"("eventId", "tokenHash");

-- CreateIndex
CREATE INDEX "Photo_orgId_idx" ON "Photo"("orgId");

-- CreateIndex
CREATE INDEX "Photo_eventId_createdAt_idx" ON "Photo"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "Photo_deviceId_idx" ON "Photo"("deviceId");

-- CreateIndex
CREATE INDEX "PhotoBlob_orgId_idx" ON "PhotoBlob"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PhotoBlob_photoId_kind_key" ON "PhotoBlob"("photoId", "kind");

-- CreateIndex
CREATE INDEX "VendorAttachment_orgId_idx" ON "VendorAttachment"("orgId");

-- CreateIndex
CREATE INDEX "VendorAttachment_vendorId_idx" ON "VendorAttachment"("vendorId");

-- AddForeignKey
ALTER TABLE "PhotoEvent" ADD CONSTRAINT "PhotoEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoDevice" ADD CONSTRAINT "PhotoDevice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoDevice" ADD CONSTRAINT "PhotoDevice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "PhotoEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "PhotoEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PhotoDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoBlob" ADD CONSTRAINT "PhotoBlob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoBlob" ADD CONSTRAINT "PhotoBlob_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAttachment" ADD CONSTRAINT "VendorAttachment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAttachment" ADD CONSTRAINT "VendorAttachment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Not in the Prisma schema: value checks, and the database half of rule 4.

ALTER TABLE "PhotoEvent" ADD CONSTRAINT "PhotoEvent_days_check" CHECK ("uploadDays" BETWEEN 0 AND 365 AND "retentionDays" BETWEEN 1 AND 3650 AND "retentionDays" >= "uploadDays");
-- A removed photo remembers what it was; any other photo remembers nothing.
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_removed_check" CHECK (("status" = 'removed') = ("removedFrom" IS NOT NULL) AND ("removedFrom" IS NULL OR "removedFrom" <> 'removed'));
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_size_check" CHECK ("width" > 0 AND "height" > 0);
ALTER TABLE "PhotoDevice" ADD CONSTRAINT "PhotoDevice_blocked_check" CHECK (("blockedAt" IS NULL) = ("blockedById" IS NULL));
-- RULE 4: what is stored is what the pipeline wrote: a JPEG (the only format it writes), its true length, within the
-- byte cap and the rendition's pixel box. A raw upload of another type cannot be stored even by a mistaken code path.
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_mime_check" CHECK ("mime" = 'image/jpeg');
ALTER TABLE "PhotoBlob" ADD CONSTRAINT "PhotoBlob_bytes_check" CHECK (substring("bytes" from 1 for 3) = '\xffd8ff'::bytea AND "size" = octet_length("bytes") AND "size" <= 10485760);
ALTER TABLE "PhotoBlob" ADD CONSTRAINT "PhotoBlob_box_check" CHECK ("width" > 0 AND "height" > 0 AND greatest("width", "height") <= CASE "kind" WHEN 'full' THEN 4096 WHEN 'display' THEN 1600 ELSE 400 END);
ALTER TABLE "VendorAttachment" ADD CONSTRAINT "VendorAttachment_bytes_check" CHECK ("mime" = 'image/jpeg' AND substring("bytes" from 1 for 3) = '\xffd8ff'::bytea AND "size" = octet_length("bytes") AND "size" <= 10485760);
ALTER TABLE "VendorAttachment" ADD CONSTRAINT "VendorAttachment_box_check" CHECK ("width" > 0 AND "height" > 0 AND greatest("width", "height") <= 4096);

-- A device and a photo belong to their event's workspace; a photo's device is that event's device.
CREATE FUNCTION knotwork_photo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "PhotoEvent" e WHERE e."id" = NEW."eventId" AND e."orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'knotwork photos: the event must belong to the same workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'Photo' THEN
    IF NOT EXISTS (SELECT 1 FROM "PhotoDevice" d WHERE d."id" = NEW."deviceId" AND d."eventId" = NEW."eventId" AND d."orgId" = NEW."orgId") THEN
      RAISE EXCEPTION 'knotwork photos: the device must belong to the same event' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PhotoDevice_guard" BEFORE INSERT OR UPDATE ON "PhotoDevice" FOR EACH ROW EXECUTE FUNCTION knotwork_photo_guard();
CREATE TRIGGER "Photo_guard" BEFORE INSERT OR UPDATE ON "Photo" FOR EACH ROW EXECUTE FUNCTION knotwork_photo_guard();

-- A blob belongs to its photo's workspace, and a purged photo holds no bytes: none can be added once it is purged,
-- and it cannot be marked purged while any remain. A purge is never undone.
CREATE FUNCTION knotwork_photo_blob_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Photo" p WHERE p."id" = NEW."photoId" AND p."orgId" = NEW."orgId" AND p."purgedAt" IS NULL) THEN
    RAISE EXCEPTION 'knotwork photos: a blob needs a photo in the same workspace that has not been purged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PhotoBlob_guard" BEFORE INSERT OR UPDATE ON "PhotoBlob" FOR EACH ROW EXECUTE FUNCTION knotwork_photo_blob_guard();

CREATE FUNCTION knotwork_photo_purge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."purgedAt" IS NOT NULL AND NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt" THEN
    RAISE EXCEPTION 'knotwork photos: a purge is never undone' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purgedAt" IS NOT NULL AND EXISTS (SELECT 1 FROM "PhotoBlob" b WHERE b."photoId" = NEW."id") THEN
    RAISE EXCEPTION 'knotwork photos: a purged photo holds no bytes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Photo_purge_guard" BEFORE UPDATE ON "Photo" FOR EACH ROW EXECUTE FUNCTION knotwork_photo_purge_guard();

-- An attachment belongs to its vendor's workspace.
CREATE FUNCTION knotwork_vendor_attachment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Vendor" v WHERE v."id" = NEW."vendorId" AND v."orgId" = NEW."orgId") THEN
    RAISE EXCEPTION 'knotwork attachments: the vendor must belong to the same workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "VendorAttachment_guard" BEFORE INSERT OR UPDATE ON "VendorAttachment" FOR EACH ROW EXECUTE FUNCTION knotwork_vendor_attachment_guard();
