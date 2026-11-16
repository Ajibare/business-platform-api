import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export const OUTLET_PROFILES = [
  'Community pharmacy',
  'Hospital pharmacy',
  'Chain outlet',
  'Wholesale distributor',
  'Other',
] as const;

export const STOCK_START_OPTIONS = ['IMPORT', 'MANUAL', 'SAMPLE', 'EMPTY'] as const;
export type StockStartOption = (typeof STOCK_START_OPTIONS)[number];

export class PharmacyProfileDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @IsIn(OUTLET_PROFILES as unknown as string[], {
    message: 'Choose the outlet type that describes this pharmacy.',
  })
  outletProfile: string;

  @IsOptional()
  @IsString()
  @Length(3, 200)
  address?: string;

  /** IANA identifier. Defaults to Africa/Lagos when omitted. */
  @IsOptional()
  @IsString()
  @Length(3, 64)
  timezone?: string;
}

export class StockSettingsDto {
  @IsInt()
  @Min(1, { message: 'Use at least 1 day.' })
  @Max(365, { message: 'Use 365 days or fewer.' })
  nearExpiryWarningDays: number;

  @IsOptional()
  @IsString()
  @Length(1, 24)
  defaultUnit?: string;

  /**
   * Omitted or null means "not configured" and must stay null — a minimum of
   * zero would silently disable low-stock warnings.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultMinStockLevel?: number | null;
}

export class StockStartDto {
  @IsIn(STOCK_START_OPTIONS as unknown as string[])
  choice: StockStartOption;
}
