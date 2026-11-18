import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestActor } from '../../modules/platform/branches/branch-access.service';

/**
 * The caller resolved from the verified token, including the permissions that
 * were worked out for their role and personal overrides.
 */
export const CurrentActor = createParamDecorator(
  (data: keyof RequestActor | undefined, ctx: ExecutionContext) => {
    const actor = ctx.switchToHttp().getRequest().actor as RequestActor | undefined;
    if (!actor) return undefined;
    return data ? actor[data] : actor;
  },
);
