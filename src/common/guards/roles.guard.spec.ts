import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let guard: RolesGuard;

  const reflectorMock = { getAllAndOverride: jest.fn() };
  const prismaMock = { membership: { findUnique: jest.fn() } };

  const contextMock = {
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({
        user: { sub: 'user-1', organisationId: 'org-1' },
      }),
    }),
  } as never;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RolesGuard,
        { provide: Reflector, useValue: reflectorMock },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    guard = moduleRef.get(RolesGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('allows access when no roles are required', async () => {
    reflectorMock.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(contextMock)).resolves.toBe(true);
  });

  it('allows access when the user has the required role', async () => {
    reflectorMock.getAllAndOverride.mockReturnValue(['OWNER', 'MANAGER']);
    prismaMock.membership.findUnique.mockResolvedValue({ role: 'MANAGER', active: true });

    await expect(guard.canActivate(contextMock)).resolves.toBe(true);
  });

  it('rejects access when the user lacks the required role', async () => {
    reflectorMock.getAllAndOverride.mockReturnValue(['OWNER']);
    prismaMock.membership.findUnique.mockResolvedValue({ role: 'INVENTORY_STAFF', active: true });

    await expect(guard.canActivate(contextMock)).rejects.toThrow(ForbiddenException);
  });

  it('rejects access when the user is not an active member', async () => {
    reflectorMock.getAllAndOverride.mockReturnValue(['OWNER']);
    prismaMock.membership.findUnique.mockResolvedValue(null);

    await expect(guard.canActivate(contextMock)).rejects.toThrow(ForbiddenException);
  });
});
