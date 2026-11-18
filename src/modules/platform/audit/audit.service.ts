import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

export interface AuditEntry {
  organizationId: string;
  /// Set when the action happened in one branch; null for organisation-wide actions.
  branchId?: string | null;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          organizationId: entry.organizationId,
          branchId: entry.branchId ?? null,
          actorId: entry.actorId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          metadata: (entry.metadata ?? {}) as never,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record audit entry ${entry.action} for ${entry.organizationId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Recent activity, newest first.
   *
   * `branchIds` narrows the list to the branches the caller may read while
   * keeping organisation-wide entries, which belong to no single branch.
   */
  async findAll(organizationId: string, limit = 100, branchIds?: string[] | null) {
    const where =
      branchIds && branchIds.length > 0
        ? { organizationId, OR: [{ branchId: null }, { branchId: { in: branchIds } }] }
        : { organizationId };

    const logs = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });

    return {
      data: logs.map((log) => ({
        id: log.id,
        organizationId: log.organizationId,
        branchId: log.branchId,
        actorId: log.actorId,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata,
        createdAt: log.createdAt,
      })),
    };
  }
}
