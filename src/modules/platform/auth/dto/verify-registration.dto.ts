import { IsEmail, IsString, Matches } from 'class-validator';

export class VerifyRegistrationDto {
  @IsEmail()
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the six-digit code from your email.' })
  code: string;
}

export class ResendVerificationDto {
  @IsEmail()
  email: string;
}
