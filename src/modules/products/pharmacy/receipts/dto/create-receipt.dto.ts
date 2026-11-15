import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { ReceiptLineDto } from './receipt-line.dto';

export class CreateReceiptDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  supplierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalReference?: string;

  @IsOptional()
  @IsDateString()
  receivedAt?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  lines: ReceiptLineDto[];
}
