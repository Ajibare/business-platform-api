import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../database/prisma.service';
import { Test } from '@nestjs/testing';
import { AuthService } from './auth.service';

jest.mock('@nestjs/jwt', () => ({
  JwtService: class MockJwtService {
    sign = jest.fn();
    verifyAsync = jest.fn();
  },
}));

describe('AuthService', () => {
  let service: AuthService;

  const prismaMock = {
    user: { create: jest.fn(), findUnique: jest.fn() },
    organization: { create: jest.fn() },
    membership: { create: jest.fn() },
  };
  const jwtMock = { sign: jest.fn(), verifyAsync: jest.fn() };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: JwtService, useValue: jwtMock },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
