import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ToBoolean } from '../../../../../common/validation/to-boolean';

export class ListSuppliersDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  q?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  active?: boolean;

  // Query strings arrive as text, so the numeric rules below only hold once the
  // value has been coerced.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
