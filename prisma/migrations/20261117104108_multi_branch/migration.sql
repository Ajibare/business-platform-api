/*
  Multi-branch migration.

  This file started as `prisma migrate dev --create-only` output and was then
  edited so existing single-branch data survives. The order is deliberate:

  1. The branch columns are added as NULLABLE.
  2. Every existing organisation gets a default "MAIN" branch.
  3. Existing batches, movements, receipts, counts and sales are moved onto it.
  4. Only then are the columns made NOT NULL.

  No pharmacy record is deleted, and inventory, batch and sales history keeps
  working exactly as before for workspaces that never create a second branch.
*/
-- CreateEnum
CREATE TYPE "BranchStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('GRANT', 'DENY');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementType" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "MovementType" ADD VALUE 'TRANSFER_IN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'ADMIN';
ALTER TYPE "Role" ADD VALUE 'BRANCH_MANAGER';
ALTER TYPE "Role" ADD VALUE 'PHARMACIST';
ALTER TYPE "Role" ADD VALUE 'INVENTORY_OFFICER';
ALTER TYPE "Role" ADD VALUE 'CASHIER';

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "branchId" TEXT;

-- AlterTable
-- Nullable first; the backfill below fills it and a later statement makes it required.
ALTER TABLE "Batch" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "ImportJob" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "dailyReportPerBranch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "NotificationRecipient" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "requireTransferApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "StaffInvitation" ADD COLUMN     "lastSentAt" TIMESTAMP(3),
ADD COLUMN     "resendCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StockCount" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "StockReceipt" ADD COLUMN     "branchId" TEXT;

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "managerUserId" TEXT,
    "status" "BranchStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchStaff" (
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchStaff_pkey" PRIMARY KEY ("branchId","userId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("organizationId","role","permission")
);

-- CreateTable
CREATE TABLE "MemberPermission" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL DEFAULT 'GRANT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberPermission_pkey" PRIMARY KEY ("organizationId","userId","permission")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "dispatchedById" TEXT,
    "receivedById" TEXT,
    "rejectedById" TEXT,
    "rejectedReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceBatchId" TEXT NOT NULL,
    "destinationBatchId" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL,
    "receivedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "damagedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvitationBranch" (
    "invitationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,

    CONSTRAINT "InvitationBranch_pkey" PRIMARY KEY ("invitationId","branchId")
);

-- CreateIndex
CREATE INDEX "Branch_organizationId_status_idx" ON "Branch"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_organizationId_code_key" ON "Branch"("organizationId", "code");

-- ---------------------------------------------------------------------------
-- Backfill: one default branch per existing organisation.
-- ---------------------------------------------------------------------------
INSERT INTO "Branch" ("id", "organizationId", "name", "code", "status", "isDefault", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    o."id",
    'Main branch',
    'MAIN',
    'ACTIVE',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Organization" o
WHERE NOT EXISTS (
    SELECT 1 FROM "Branch" b WHERE b."organizationId" = o."id"
);

-- Every existing record now belongs to that branch, so single-branch
-- workspaces resolve to the same stock and sales they had before.
UPDATE "Batch" t
SET "branchId" = b."id"
FROM "Branch" b
WHERE b."organizationId" = t."organizationId" AND b."isDefault" = true AND t."branchId" IS NULL;

UPDATE "StockMovement" t
SET "branchId" = b."id"
FROM "Branch" b
WHERE b."organizationId" = t."organizationId" AND b."isDefault" = true AND t."branchId" IS NULL;

UPDATE "StockReceipt" t
SET "branchId" = b."id"
FROM "Branch" b
WHERE b."organizationId" = t."organizationId" AND b."isDefault" = true AND t."branchId" IS NULL;

UPDATE "StockCount" t
SET "branchId" = b."id"
FROM "Branch" b
WHERE b."organizationId" = t."organizationId" AND b."isDefault" = true AND t."branchId" IS NULL;

UPDATE "Sale" t
SET "branchId" = b."id"
FROM "Branch" b
WHERE b."organizationId" = t."organizationId" AND b."isDefault" = true AND t."branchId" IS NULL;

-- Keep existing members able to see the stock they already had.
INSERT INTO "BranchStaff" ("branchId", "userId", "createdAt")
SELECT b."id", m."userId", CURRENT_TIMESTAMP
FROM "Membership" m
JOIN "Branch" b ON b."organizationId" = m."organizationId" AND b."isDefault" = true
ON CONFLICT DO NOTHING;

-- Only now that every row has a branch do the columns become required.
ALTER TABLE "Batch" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "StockMovement" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "StockReceipt" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "StockCount" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "Sale" ALTER COLUMN "branchId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "BranchStaff_userId_idx" ON "BranchStaff"("userId");

-- CreateIndex
CREATE INDEX "RolePermission_organizationId_role_idx" ON "RolePermission"("organizationId", "role");

-- CreateIndex
CREATE INDEX "MemberPermission_userId_idx" ON "MemberPermission"("userId");

-- CreateIndex
CREATE INDEX "StockTransfer_organizationId_status_createdAt_idx" ON "StockTransfer"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "StockTransfer_organizationId_fromBranchId_createdAt_idx" ON "StockTransfer"("organizationId", "fromBranchId", "createdAt");

-- CreateIndex
CREATE INDEX "StockTransfer_organizationId_toBranchId_createdAt_idx" ON "StockTransfer"("organizationId", "toBranchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_organizationId_reference_key" ON "StockTransfer"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "StockTransferLine_transferId_idx" ON "StockTransferLine"("transferId");

-- CreateIndex
CREATE INDEX "StockTransferLine_sourceBatchId_idx" ON "StockTransferLine"("sourceBatchId");

-- CreateIndex
CREATE INDEX "StockTransferLine_destinationBatchId_idx" ON "StockTransferLine"("destinationBatchId");

-- CreateIndex
CREATE INDEX "InvitationBranch_branchId_idx" ON "InvitationBranch"("branchId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_branchId_createdAt_idx" ON "AuditLog"("organizationId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "Batch_branchId_productId_expiryDate_idx" ON "Batch"("branchId", "productId", "expiryDate");

-- CreateIndex
CREATE INDEX "Sale_organizationId_branchId_occurredAt_idx" ON "Sale"("organizationId", "branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockCount_organizationId_branchId_startedAt_idx" ON "StockCount"("organizationId", "branchId", "startedAt");

-- CreateIndex
CREATE INDEX "StockMovement_organizationId_branchId_occurredAt_idx" ON "StockMovement"("organizationId", "branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockReceipt_organizationId_branchId_receivedAt_idx" ON "StockReceipt"("organizationId", "branchId", "receivedAt");

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchStaff" ADD CONSTRAINT "BranchStaff_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchStaff" ADD CONSTRAINT "BranchStaff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPermission" ADD CONSTRAINT "MemberPermission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPermission" ADD CONSTRAINT "MemberPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_sourceBatchId_fkey" FOREIGN KEY ("sourceBatchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_destinationBatchId_fkey" FOREIGN KEY ("destinationBatchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationBranch" ADD CONSTRAINT "InvitationBranch_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "StaffInvitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationBranch" ADD CONSTRAINT "InvitationBranch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
