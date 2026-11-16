import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min, MaxLength } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  expiryRemindersEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  saleNotificationsEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  reminderLeadDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  reminderIntervalDays?: number;

  @IsOptional()
  @IsBoolean()
  dailyReportEnabled?: boolean;

  /** Local delivery time, evaluated in `dailyReportTimezone`. */
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'dailyReportTime must use the 24 hour HH:mm format.',
  })
  dailyReportTime?: string;

  /** IANA timezone name; an empty string clears the override. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  dailyReportTimezone?: string;
}
