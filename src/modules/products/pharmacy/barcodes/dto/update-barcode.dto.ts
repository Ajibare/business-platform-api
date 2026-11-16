import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateBarcodeDto {
  /** Pass `null` to clear the barcode for a product. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(64)
  barcode!: string | null;
}
