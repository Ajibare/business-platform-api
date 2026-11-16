import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { IMPORT_TYPES, ImportType } from '../import-templates';

export class CreateImportDto {
  @IsIn(IMPORT_TYPES as readonly string[])
  type!: ImportType;

  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  filename!: string;

  /** Raw CSV text, or base64 for an .xlsx workbook. */
  @IsNotEmpty()
  @IsString()
  content!: string;

  /** How `content` is encoded. Defaults to base64 for .xlsx and text for CSV. */
  @IsOptional()
  @IsIn(['text', 'base64'])
  encoding?: 'text' | 'base64';

  /** Optional template column key -> uploaded header label overrides. */
  @IsOptional()
  @IsObject()
  mapping?: Record<string, string>;
}
