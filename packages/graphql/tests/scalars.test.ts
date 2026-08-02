import { describe, expect, it } from 'bun:test';
import {
  Bool,
  DateTime,
  Float,
  ID,
  Int,
  isScalarName,
  Json,
  ScalarRef,
  Str,
  scalarNameForConstructor,
} from '../src/scalars.ts';

describe('ScalarRef', () => {
  it('stores the scalar name', () => {
    const ref = new ScalarRef('ID');
    expect(ref.scalarName).toBe('ID');
  });

  it('toString returns the scalar name', () => {
    const ref = new ScalarRef('DateTime');
    expect(ref.toString()).toBe('DateTime');
  });
});

describe('scalar constants', () => {
  it('ID is a ScalarRef with name "ID"', () => {
    expect(ID).toBeInstanceOf(ScalarRef);
    expect(ID.scalarName).toBe('ID');
  });

  it('Int is a ScalarRef with name "Int"', () => {
    expect(Int).toBeInstanceOf(ScalarRef);
    expect(Int.scalarName).toBe('Int');
  });

  it('Float is a ScalarRef with name "Float"', () => {
    expect(Float).toBeInstanceOf(ScalarRef);
    expect(Float.scalarName).toBe('Float');
  });

  it('Str is a ScalarRef with name "String"', () => {
    expect(Str).toBeInstanceOf(ScalarRef);
    expect(Str.scalarName).toBe('String');
  });

  it('Bool is a ScalarRef with name "Boolean"', () => {
    expect(Bool).toBeInstanceOf(ScalarRef);
    expect(Bool.scalarName).toBe('Boolean');
  });

  it('DateTime is a ScalarRef with name "DateTime"', () => {
    expect(DateTime).toBeInstanceOf(ScalarRef);
    expect(DateTime.scalarName).toBe('DateTime');
  });

  it('Json is a ScalarRef with name "JSON"', () => {
    expect(Json).toBeInstanceOf(ScalarRef);
    expect(Json.scalarName).toBe('JSON');
  });
});

describe('isScalarName', () => {
  it('returns true for spec scalars', () => {
    expect(isScalarName('ID')).toBe(true);
    expect(isScalarName('String')).toBe(true);
    expect(isScalarName('Int')).toBe(true);
    expect(isScalarName('Float')).toBe(true);
    expect(isScalarName('Boolean')).toBe(true);
  });

  it('returns true for custom scalars', () => {
    expect(isScalarName('DateTime')).toBe(true);
    expect(isScalarName('JSON')).toBe(true);
  });

  it('returns false for unknown names', () => {
    expect(isScalarName('UUID')).toBe(false);
    expect(isScalarName('Email')).toBe(false);
  });
});

describe('scalarNameForConstructor', () => {
  it('maps String to String', () => {
    expect(scalarNameForConstructor(String)).toBe('String');
  });

  it('maps Number to Float', () => {
    expect(scalarNameForConstructor(Number)).toBe('Float');
  });

  it('maps Boolean to Boolean', () => {
    expect(scalarNameForConstructor(Boolean)).toBe('Boolean');
  });

  it('maps Date to DateTime', () => {
    expect(scalarNameForConstructor(Date)).toBe('DateTime');
  });

  it('returns undefined for unknown constructors', () => {
    expect(scalarNameForConstructor(Symbol)).toBeUndefined();
    expect(scalarNameForConstructor(Array)).toBeUndefined();
  });
});
