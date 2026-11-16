import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class SignInDto {
  /** Email address or Nigerian mobile number. */
  @IsString()
  @IsNotEmpty({ message: 'Enter your email address or phone number.' })
  @Length(5, 120)
  identifier: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your password.' })
  password: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

/**
 * Kept so the pre-existing `/auth/login` contract keeps working for any client
 * that has not moved to `/auth/sign-in` yet. Both shapes authenticate through
 * the same service method.
 */
export class LegacySignInDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  identifier?: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
