import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class ForgotPasswordDto {
  /** Email address or Nigerian mobile number. */
  @IsString()
  @IsNotEmpty({ message: 'Enter your email address or phone number.' })
  @Length(5, 120)
  identifier: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @Length(1, 200)
  password: string;

  @IsOptional()
  @IsString()
  confirmPassword?: string;
}
