import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TransferStatus } from '@prisma/client';

export class ReceivedLineDto {
  @IsString()
  lineId!: string;

  /** Good units that arrived. Defaults to the dispatched quantity. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  receivedQuantity!: number;

  /** Units that arrived damaged; they are received then written off. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  damagedQuantity?: number;
}

export class ReceiveTransferDto {
  /** Omit to receive every line in full. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReceivedLineDto)
  lines?: ReceivedLineDto[];

  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectTransferDto {
  @IsString()
  reason!: string;
}

export class ListTransfersDto {
  @IsOptional()
  @IsIn(Object.values(TransferStatus))
  status?: TransferStatus;

  /** Narrows the list to transfers leaving or entering a branch. */
  @IsOptional()
  @IsIn(['in', 'out', 'all'])
  direction?: 'in' | 'out' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;
}
