import { Global, Module } from '@nestjs/common';
import { BranchAccessService } from '../branches/branch-access.service';
import { AuditModule } from '../audit/audit.module';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

/**
 * Global so every feature module can inject `PermissionsService` and
 * `BranchAccessService` without repeating the import, and so the guards used
 * with `@UseGuards(...)` resolve in any controller.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [PermissionsController],
  providers: [PermissionsService, BranchAccessService],
  exports: [PermissionsService, BranchAccessService],
})
export class PermissionsModule {}
