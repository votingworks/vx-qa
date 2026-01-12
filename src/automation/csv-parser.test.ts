/**
 * Tests for CSV parsing utilities
 */

import { describe, it, expect } from 'vitest';
import { parseCsvLine } from './admin-tally-workflow.js';

describe('parseCsvLine', () => {
  it('should parse simple CSV line without quotes', () => {
    const line = 'field1,field2,field3';
    const result = parseCsvLine(line);
    expect(result).toEqual(['field1', 'field2', 'field3']);
  });

  it('should parse CSV line with quoted field containing comma', () => {
    const line = 'Article 2,sn3rk9cmwyyb,"Yes, of course",jvk9dih8u8p7,2';
    const result = parseCsvLine(line);
    expect(result).toEqual(['Article 2', 'sn3rk9cmwyyb', 'Yes, of course', 'jvk9dih8u8p7', '2']);
  });

  it('should handle multiple quoted fields with commas', () => {
    const line = '"First, Name","Last, Name",Age';
    const result = parseCsvLine(line);
    expect(result).toEqual(['First, Name', 'Last, Name', 'Age']);
  });

  it('should handle escaped quotes within quoted fields', () => {
    const line = '"Say ""Hello""","World"';
    const result = parseCsvLine(line);
    expect(result).toEqual(['Say "Hello"', 'World']);
  });

  it('should trim whitespace from unquoted fields', () => {
    const line = ' field1 , field2 , field3 ';
    const result = parseCsvLine(line);
    expect(result).toEqual(['field1', 'field2', 'field3']);
  });

  it('should handle empty fields', () => {
    const line = 'field1,,field3';
    const result = parseCsvLine(line);
    expect(result).toEqual(['field1', '', 'field3']);
  });

  it('should handle quoted empty fields', () => {
    const line = 'field1,"",field3';
    const result = parseCsvLine(line);
    expect(result).toEqual(['field1', '', 'field3']);
  });

  it('should handle line with only commas', () => {
    const line = ',,,';
    const result = parseCsvLine(line);
    expect(result).toEqual(['', '', '', '']);
  });

  it('should handle single field', () => {
    const line = 'onlyfield';
    const result = parseCsvLine(line);
    expect(result).toEqual(['onlyfield']);
  });

  it('should preserve whitespace within quoted fields', () => {
    const line = '"  spaces  ","tabs\t"';
    const result = parseCsvLine(line);
    expect(result).toEqual(['  spaces  ', 'tabs\t']);
  });
});
