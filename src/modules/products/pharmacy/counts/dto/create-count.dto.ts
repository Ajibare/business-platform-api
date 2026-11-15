import { ArrayUnique, IsArray, IsIn, IsOptional } from 'class-validator';

export class CreateCountDto {
  @IsIn(['ALL', 'TARGETED'])
  scope: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  productIds?: string[];
}
