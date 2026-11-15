import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MovementType } from '@prisma/client';

export class ListMovementsDto {
  @IsOptional()
  @IsString()
  batchId?: string;

  @IsOptional()
  @IsEnum(MovementType)
  type?: MovementType;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}
