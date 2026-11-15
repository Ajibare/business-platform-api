import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListBatchesDto {
  @IsOptional()
  @IsString()
  medicineId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  batchNumber?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;
}
