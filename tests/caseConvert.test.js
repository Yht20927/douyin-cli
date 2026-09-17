// tests/caseConvert.test.js

const { camelToSnake, convertKeys } = require('../core/shared/caseConvert');

describe('camelToSnake', () => {
  it('should convert camelCase to snake_case', () => {
    expect(camelToSnake('camelCase')).toBe('camel_case');
  });

  it('should handle already snake_case', () => {
    expect(camelToSnake('snake_case')).toBe('snake_case');
  });

  it('should handle single char', () => {
    expect(camelToSnake('a')).toBe('a');
  });

  it('should handle all lowercase', () => {
    expect(camelToSnake('already_lower')).toBe('already_lower');
  });

  it('should handle multi-word camelCase', () => {
    expect(camelToSnake('noteCardXsecToken')).toBe('note_card_xsec_token');
  });

  it('should handle numbers', () => {
    expect(camelToSnake('field2Name')).toBe('field2_name');
  });
});

describe('convertKeys', () => {
  it('should convert camelCase keys in object', () => {
    const input = { noteId: '123', noteCard: { xsecToken: 'abc' } };
    const result = convertKeys(input);
    expect(result.note_id).toBe('123');
    expect(result.note_card.xsec_token).toBe('abc');
    expect(result.noteId).toBeUndefined();
  });

  it('should handle arrays', () => {
    const input = [{ noteId: '1' }, { noteId: '2' }];
    const result = convertKeys(input);
    expect(result[0].note_id).toBe('1');
    expect(result[1].note_id).toBe('2');
  });

  it('should keep snake_case keys when both exist', () => {
    const input = { noteId: 'camel', note_id: 'snake' };
    const result = convertKeys(input);
    expect(result.note_id).toBe('snake');
    expect(result.noteId).toBeUndefined();
  });

  it('should return primitives as-is', () => {
    expect(convertKeys(null)).toBeNull();
    expect(convertKeys(42)).toBe(42);
    expect(convertKeys('hello')).toBe('hello');
  });
});
