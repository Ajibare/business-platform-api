import { Equals, IsBoolean, IsEmail, IsOptional, IsString, Length } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @IsEmail()
  email: string;

  /** Optional at the schema level; the service accepts Nigerian mobile formats. */
  @IsOptional()
  @IsString()
  @Length(7, 24)
  phone?: string;

  @IsString()
  @Length(1, 200)
  password: string;

  @IsOptional()
  @IsString()
  confirmPassword?: string;

  @IsBoolean()
  @Equals(true, { message: 'You must accept the terms of service and privacy policy.' })
  termsAccepted: boolean;
}
