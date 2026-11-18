import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MembershipStatus, Role } from '@prisma/client';

export class StaffListQueryDto {
  /** Matches name, email or phone. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  phone?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** Replaces the branch assignments when present. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  branchIds?: string[];
}

export class StaffStatusDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

export class StaffActivityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Roles an administrator may hand out. Ownership never moves by edit. */
export const ASSIGNABLE_ROLES: readonly Role[] = [
  Role.ADMIN,
  Role.BRANCH_MANAGER,
  Role.PHARMACIST,
  Role.INVENTORY_OFFICER,
  Role.CASHIER,
  Role.MANAGER,
  Role.INVENTORY_STAFF,
  Role.READ_ONLY,
];
