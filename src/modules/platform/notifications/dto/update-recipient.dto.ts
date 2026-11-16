import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateNotificationRecipientDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  receivesExpiry?: boolean;

  @IsOptional()
  @IsBoolean()
  receivesSales?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
