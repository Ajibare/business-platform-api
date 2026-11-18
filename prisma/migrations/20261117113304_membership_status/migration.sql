-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusReason" TEXT;

-- Existing memberships keep their access: anyone already switched off becomes
-- DEACTIVATED so the new status column agrees with the older `active` flag.
UPDATE "Membership" SET "status" = 'DEACTIVATED' WHERE "active" = false;
