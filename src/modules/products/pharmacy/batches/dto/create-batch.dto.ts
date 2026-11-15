import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateBatchDto {
  @IsNotEmpty()
  @IsString()
  medicineId: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  batchNumber?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;

  @IsOptional()
  @IsNumber()
  unitCost?: number;

  @IsOptional()
  @IsNumber()
  sellingPrice?: number;

  @IsNumber()
  @Min(0)
  quantity: number;

  @IsNotEmpty()
  @IsString()
  idempotencyKey: string;
}
