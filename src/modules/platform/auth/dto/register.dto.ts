import {
  Equals,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { PASSWORD_MIN_LENGTH } from '../auth.constants';

/**
 * Messages are written here rather than left to class-validator's defaults
 * because the form shows them verbatim next to the offending input.
 */
export class RegisterDto {
  @IsString({ message: 'Enter your full name.' })
  @Length(2, 120, { message: 'Enter your full name (at least 2 characters).' })
  name: string;

  @MaxLength(254, { message: 'Enter an email address with at most 254 characters.' })
  @IsEmail({}, { message: 'Enter a valid email address, for example name@pharmacy.com.' })
  email: string;

  /** Optional at the schema level; the service accepts Nigerian mobile formats. */
  @IsOptional()
  @IsString({ message: 'Enter a valid phone number.' })
  @Length(7, 24, { message: 'Enter a valid phone number, for example 0803 123 4567.' })
  phone?: string;

  @IsString({ message: 'Choose a password.' })
  @Length(PASSWORD_MIN_LENGTH, 200, {
    message: `Use at least ${PASSWORD_MIN_LENGTH} characters for your password.`,
  })
  password: string;

  @IsOptional()
  @IsString({ message: 'Confirm your password.' })
  confirmPassword?: string;

  @IsBoolean({ message: 'Accept the terms of service and privacy policy to continue.' })
  @Equals(true, { message: 'You must accept the terms of service and privacy policy.' })
  termsAccepted: boolean;
}
