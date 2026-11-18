-- Additive index migration: no table, column or row is modified.
--
-- Both indexes exist because of a specific query shape, not as a guess:
--
-- 1. Expiry alerts, near-expiry and expired lists (expiry.service.ts) filter by
--    organisation + branch and then range and sort on expiryDate. The existing
--    (branchId, productId, expiryDate) index cannot serve that range because
--    productId sits between the two columns it would need to combine.
CREATE INDEX "Batch_organizationId_branchId_expiryDate_idx"
  ON "Batch"("organizationId", "branchId", "expiryDate");

-- 2. The staff activity tab (staff.service.ts) lists one member's audit entries,
--    newest first, scoped to the organisation.
CREATE INDEX "AuditLog_organizationId_actorId_createdAt_idx"
  ON "AuditLog"("organizationId", "actorId", "createdAt");
