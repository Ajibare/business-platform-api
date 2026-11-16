import { IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';

export const INVITABLE_ROLES = ['MANAGER', 'INVENTORY_STAFF', 'READ_ONLY'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export class CreateInvitationDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(7, 24)
  phone?: string;

  /** OWNER can never be invited: the first account is the owner by registration. */
  @IsIn(INVITABLE_ROLES as unknown as string[], {
    message: 'Choose Manager, Inventory staff or Read-only.',
  })
  role: InvitableRole;
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
