import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/** Branch codes are short, human-readable and unique inside the organisation. */
const BRANCH_CODE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export class CreateBranchDto {
  @IsString()
  @Length(2, 80)
  name!: string;

  @IsString()
  @Length(2, 16)
  @Matches(BRANCH_CODE, {
    message: 'Use letters, numbers and dashes, starting with a letter or number.',
  })
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  managerUserId?: string;
}

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(2, 16)
  @Matches(BRANCH_CODE, {
    message: 'Use letters, numbers and dashes, starting with a letter or number.',
  })
  code?: string;

  /** Send null to clear a field. */
  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsEmail()
  email?: string | null;
}

export class AssignBranchManagerDto {
  /** Null clears the manager without touching their branch assignment. */
  @IsOptional()
  @IsString()
  managerUserId?: string | null;
}

export class AssignBranchStaffDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Type(() => String)
  userIds!: string[];
}
