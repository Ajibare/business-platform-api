import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { BranchScope } from '../../modules/platform/branches/branch-access.service';

/**
 * The branch scope a `BranchScopeGuard` resolved for this request.
 *
 * `@CurrentBranch()` gives the single branch a write belongs to, while
 * `@CurrentBranch('branchIds')` gives every branch the request may read.
 */
export const CurrentBranch = createParamDecorator(
  (data: keyof BranchScope | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const scope = request.branchScope as BranchScope | undefined;
    if (!scope) return data ? undefined : null;
    return data ? scope[data] : scope;
  },
);
