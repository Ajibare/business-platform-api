import { IsDateString, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { MovementType } from '@prisma/client';

export class CreateMovementDto {
  @IsNotEmpty()
  @IsString()
  batchId: string;

  @IsEnum(MovementType)
  type: MovementType;

  @IsNumber()
  quantityDelta: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reversalOfId?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
