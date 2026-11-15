import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class AddCountLineDto {
  @IsNotEmpty()
  @IsString()
  batchId: string;

  @IsNotEmpty()
  @IsNumber()
  countedQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}
