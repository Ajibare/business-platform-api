import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { BranchAccessService } from '../../modules/platform/branches/branch-access.service';

/**
 * Resolves the branch a request works in and rejects any branch the caller may
 * not reach.
 *
 * The branch hint comes from the `X-Branch-Id` header or the `branchId` query
 * parameter, but it is only ever a request: the resolved scope is written back
 * to `request.branchScope` and handlers read it from there.
 */
@Injectable()
export class BranchScopeGuard implements CanActivate {
  constructor(private readonly branchAccess: BranchAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    await this.branchAccess.scopeFor(request);
    return true;
  }
}
