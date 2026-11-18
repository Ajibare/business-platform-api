import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import { BranchAccessService } from '../../modules/platform/branches/branch-access.service';
import {
  PERMISSION_CATALOGUE,
  type PermissionKey,
} from '../../modules/platform/permissions/permission-catalogue';

/**
 * Enforces `@RequirePermission(...)`.
 *
 * Resolving the actor verifies the membership and the account status, so a
 * suspended or removed member loses access on their next request even if their
 * token has not expired.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const actor = await this.branchAccess.resolveActor(request);

    const missing = required.filter((permission) => !actor.permissions.has(permission));
    if (missing.length === 0) {
      return true;
    }

    const labels = missing.map(
      (key) => PERMISSION_CATALOGUE.find((entry) => entry.key === key)?.label ?? key,
    );

    throw new ForbiddenException({
      code: 'PERMISSION_DENIED',
      message: `Your role does not allow this action (${labels.join(', ')}).`,
    });
  }
}
