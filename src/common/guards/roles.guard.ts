import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role } from '@prisma/client';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userId = request?.user?.sub as string | undefined;
    const organisationId = (request?.user?.organisationId ?? request?.organisationId) as
      | string
      | undefined;

    if (!userId || !organisationId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Organisation context is missing for the authenticated user.',
      });
    }

    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId: organisationId, userId } },
    });

    if (!membership || !membership.active) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'User is not an active member of the organisation.',
      });
    }

    if (!requiredRoles.includes(membership.role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'User does not have the required role for this action.',
      });
    }

    return true;
  }
}
