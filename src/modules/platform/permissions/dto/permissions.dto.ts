import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

export class SetRolePermissionsDto {
  /** The complete permission set the role should end up with. */
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions: string[];
}

export class SetMemberPermissionsDto {
  /** Permissions granted on top of the member's role. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  grants?: string[];

  /** Permissions removed from the member's role. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  denies?: string[];
}
