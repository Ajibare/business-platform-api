import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

/**
 * Owner is never invited: the first account becomes the owner at registration.
 * The legacy names stay invitable so an older workspace keeps working.
 */
export const INVITABLE_ROLES = [
  'ADMIN',
  'BRANCH_MANAGER',
  'PHARMACIST',
  'INVENTORY_OFFICER',
  'CASHIER',
  'MANAGER',
  'INVENTORY_STAFF',
  'READ_ONLY',
] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export class CreateInvitationDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(7, 24)
  phone?: string;

  @IsIn(INVITABLE_ROLES as unknown as string[], {
    message: 'Choose a role for this person.',
  })
  role: InvitableRole;

  /** Branches this person will work in once they accept. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  branchIds?: string[];
}

export class AcceptInvitationDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @IsString()
  @Length(1, 200)
  password: string;

  @IsOptional()
  @IsString()
  confirmPassword?: string;
}
