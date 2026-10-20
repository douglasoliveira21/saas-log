import { TaxRegime, EstablishmentKind, WarehouseKind } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isValidCnpj } from '../common/cnpj';
import { IsBrPhone } from '../common/phone';

@ValidatorConstraint({ name: 'cnpj', async: false })
export class CnpjConstraint implements ValidatorConstraintInterface {
  validate(v: unknown) {
    return typeof v === 'string' && isValidCnpj(v);
  }
  defaultMessage() {
    return 'CNPJ inválido.';
  }
}

const UF = /^[A-Za-z]{2}$/;

export class CreateCompanyDto {
  @IsString() @Length(2, 200) legalName: string;
  @IsOptional() @IsString() @MaxLength(200) tradeName?: string;
  @IsOptional() @Validate(CnpjConstraint) cnpj?: string;
  @IsOptional() @IsEnum(TaxRegime) taxRegime?: TaxRegime;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsBrPhone() @MaxLength(30) contactPhone?: string;
  @IsOptional() @IsString() @MaxLength(120) responsible?: string;
}

export class UpdateCompanyDto {
  @IsOptional() @IsString() @Length(2, 200) legalName?: string;
  @IsOptional() @IsString() @MaxLength(200) tradeName?: string;
  @IsOptional() @Validate(CnpjConstraint) cnpj?: string;
  @IsOptional() @IsEnum(TaxRegime) taxRegime?: TaxRegime;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsBrPhone() @MaxLength(30) contactPhone?: string;
  @IsOptional() @IsString() @MaxLength(120) responsible?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class AddressFields {
  @IsOptional() @IsString() @Matches(/^\d{5}-?\d{3}$/, { message: 'CEP inválido.' }) zipCode?: string;
  @IsOptional() @IsString() @MaxLength(200) street?: string;
  @IsOptional() @IsString() @MaxLength(20) number?: string;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @Matches(UF, { message: 'UF inválida.' }) state?: string;
}

export class CreateEstablishmentDto extends AddressFields {
  @IsUUID() companyId: string;
  @IsEnum(EstablishmentKind) kind: EstablishmentKind;
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @Validate(CnpjConstraint) cnpj?: string;
  @IsOptional() @IsString() @MaxLength(30) stateRegistration?: string;
  @IsOptional() @IsString() @MaxLength(30) municipalRegistration?: string;
  @IsOptional() @Matches(/^\d{4}-?\d\/?\d{2}$|^\d{7}$/, { message: 'CNAE inválido.' }) cnae?: string;
  @IsOptional() @IsString() @MaxLength(30) complement?: string;
}

export class UpdateEstablishmentDto extends AddressFields {
  @IsOptional() @IsString() @MaxLength(30) complement?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @Validate(CnpjConstraint) cnpj?: string;
  @IsOptional() @IsString() @MaxLength(30) stateRegistration?: string;
  @IsOptional() @IsString() @MaxLength(30) municipalRegistration?: string;
  @IsOptional() @Matches(/^\d{4}-?\d\/?\d{2}$|^\d{7}$/, { message: 'CNAE inválido.' }) cnae?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateWarehouseDto extends AddressFields {
  @IsUUID() establishmentId: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{2,20}$/, { message: 'Código: 2 a 20 letras, números, - ou _.' }) code: string;
  @IsString() @Length(2, 120) name: string;
  @IsOptional() @IsEnum(WarehouseKind) kind?: WarehouseKind;
}

export class UpdateWarehouseDto extends AddressFields {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsEnum(WarehouseKind) kind?: WarehouseKind;
  @IsOptional() @IsBoolean() active?: boolean;
}
