import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateTransferLineDto {
  /** The batch stock leaves from; it must belong to the source branch. */
  @IsString()
  @IsNotEmpty()
  sourceBatchId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
}

export class CreateTransferDto {
  /** Defaults to the branch the caller is working in. */
  @IsOptional()
  @IsString()
  fromBranchId?: string;

  @IsString()
  @IsNotEmpty()
  toBranchId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Submit immediately instead of leaving the request in draft. */
  @IsOptional()
  @IsBoolean()
  submit?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateTransferLineDto)
  lines!: CreateTransferLineDto[];
}
