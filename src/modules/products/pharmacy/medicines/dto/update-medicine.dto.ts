import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateMedicineDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  normalizedName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  strength?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  dosageForm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  packSize?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;

  @IsOptional()
  @IsNumber()
  reorderThreshold?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
