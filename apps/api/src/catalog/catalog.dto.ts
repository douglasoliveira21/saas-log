import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, Validate, ValidateIf, ValidateNested,
  ValidatorConstraint, ValidatorConstraintInterface,
} from 'class-validator';
import { isValidCnpj, isValidCpf } from '../common/cnpj';
import { IsBrPhone } from '../common/phone';

@ValidatorConstraint({ name: 'cpfCnpj', async: false })
export class CpfCnpjConstraint implements ValidatorConstraintInterface {
  validate(v: unknown) {
    return typeof v === 'string' && (isValidCnpj(v) || isValidCpf(v));
  }
  defaultMessage() {
    return 'CPF/CNPJ inválido.';
  }
}

const money = { maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false } as const;

export class CreateCategoryDto {
  @IsString() @Length(2, 80) name: string;
}

export class AttributeDto {
  @IsString() @Length(1, 60) name: string;
  @IsString() @Length(1, 255) value: string;
}

export class ProductFields {
  /** Título comercial do anúncio (marketplaces limitam; o Mercado Livre usa 60 caracteres). Vazio = usa o nome interno. */
  @IsOptional() @IsString() @MaxLength(150) title?: string;
  @ValidateIf((o: ProductFields) => o.condition !== undefined) @IsIn(['NEW', 'USED', 'REFURBISHED'], { message: 'Condição inválida (NEW, USED ou REFURBISHED).' }) condition?: string;
  @IsOptional() @IsInt() @Min(0) @Max(240) warrantyMonths?: number;
  @IsOptional() @IsString() @MaxLength(60) mpn?: string;
  /** Ficha técnica: pares nome/valor (cor, voltagem, material…). */
  @ValidateIf((o: ProductFields) => o.attributes !== undefined) @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AttributeDto) attributes?: AttributeDto[];
  @IsOptional() @IsString() @Length(8, 14) @Matches(/^\d+$/, { message: 'Código de barras deve conter apenas dígitos.' }) barcode?: string;
  @IsOptional() @IsString() @MaxLength(300) shortDescription?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(100) brand?: string;
  @IsOptional() @IsString() @MaxLength(100) manufacturer?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @Length(1, 6) saleUnit?: string;
  @IsOptional() @IsString() @Length(1, 6) purchaseUnit?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100000) unitConversion?: number;
  @IsOptional() @IsInt() @Min(0) netWeightG?: number;
  @IsOptional() @IsInt() @Min(0) grossWeightG?: number;
  @IsOptional() @IsInt() @Min(0) heightMm?: number;
  @IsOptional() @IsInt() @Min(0) widthMm?: number;
  @IsOptional() @IsInt() @Min(0) lengthMm?: number;
  @IsOptional() @IsNumber(money) @Min(0) costPrice?: number;
  @IsOptional() @IsNumber(money) @Min(0) extraCost?: number;
  @IsOptional() @IsNumber(money) @Min(0) suggestedPrice?: number;
  @IsOptional() @IsNumber(money) @Min(0) minPrice?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) targetMarginPct?: number;
  @IsOptional() @IsInt() @Min(0) minStock?: number;
  @IsOptional() @IsInt() @Min(0) maxStock?: number;
  @IsOptional() @IsInt() @Min(0) reorderPoint?: number;
  @IsOptional() @IsInt() @Min(0) leadTimeDays?: number;
  @IsOptional() @IsString() @MaxLength(100) locationNote?: string;
  @IsOptional() @Matches(/^\d{8}$/, { message: 'NCM deve ter 8 dígitos.' }) ncm?: string;
  @IsOptional() @Matches(/^\d{7}$/, { message: 'CEST deve ter 7 dígitos.' }) cest?: string;
  @IsOptional() @IsInt() @Min(0) @Max(8) taxOrigin?: number;
  @IsOptional() @IsString() @Length(1, 6) taxUnit?: string;
  @IsOptional() @Matches(/^\d{8,14}$/, { message: 'GTIN tributário inválido.' }) taxGtin?: string;
}

export class CreateProductDto extends ProductFields {
  @IsString() @Matches(/^[A-Za-z0-9._\-/]{1,60}$/, { message: 'SKU: letras, números . _ - / (até 60).' }) sku: string;
  @IsString() @Length(2, 200) name: string;
}

export class UpdateProductDto extends ProductFields {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ProductQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() fiscal?: 'pending';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class ImportDto {
  @IsString() @MaxLength(5_000_000) csv: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsBoolean() skipInvalid?: boolean;
}

export class SupplierFields {
  @IsOptional() @IsString() @MaxLength(200) tradeName?: string;
  @IsOptional() @Validate(CpfCnpjConstraint) document?: string;
  @IsOptional() @IsString() @MaxLength(30) stateRegistration?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBrPhone() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) paymentTerms?: string;
  @IsOptional() @IsInt() @Min(0) @Max(365) leadTimeDays?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
export class CreateSupplierDto extends SupplierFields {
  @IsString() @Length(2, 200) legalName: string;
}
export class UpdateSupplierDto extends SupplierFields {
  @IsOptional() @IsString() @Length(2, 200) legalName?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class LinkSupplierDto {
  @IsUUID() supplierId: string;
  @IsOptional() @IsString() @MaxLength(60) supplierSku?: string;
  @IsOptional() @IsNumber(money) @Min(0) lastPrice?: number;
  @IsOptional() @IsBoolean() isMain?: boolean;
}
