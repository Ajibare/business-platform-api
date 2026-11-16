import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LookupBarcodeDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  code!: string;
}
