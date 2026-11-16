import {
  assessPassword,
  generateVerificationCode,
  hashSecret,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
  safeEqual,
  slugify,
} from './auth.utils';

describe('auth.utils', () => {
  describe('normalizePhone', () => {
    it.each([
      ['08031234567', '+2348031234567'],
      ['0803 123 4567', '+2348031234567'],
      ['8031234567', '+2348031234567'],
      ['+2348031234567', '+2348031234567'],
      ['2348031234567', '+2348031234567'],
      ['0803-123-4567', '+2348031234567'],
      ['(0803) 123 4567', '+2348031234567'],
    ])('normalises %s to %s', (input, expected) => {
      expect(normalizePhone(input)).toBe(expected);
    });

    it.each(['', '12345', '0803123456', '09012345678x', 'abc1234567', '+447700900123'])(
      'rejects %s',
      (input) => {
        expect(normalizePhone(input)).toBeNull();
      },
    );
  });

  describe('normalizeIdentifier', () => {
    it('detects email identifiers', () => {
      expect(normalizeIdentifier('  Owner@Example.COM ')).toEqual({
        channel: 'email',
        value: 'owner@example.com',
      });
    });

    it('detects phone identifiers', () => {
      expect(normalizeIdentifier('0803 123 4567')).toEqual({
        channel: 'phone',
        value: '+2348031234567',
      });
    });

    it('returns null for unusable input', () => {
      expect(normalizeIdentifier('   ')).toBeNull();
    });
  });

  it('lowercases and trims emails', () => {
    expect(normalizeEmail('  Ada@Pharmacy.NG ')).toBe('ada@pharmacy.ng');
  });

  describe('assessPassword', () => {
    it('rejects short passwords without the required character classes', () => {
      const result = assessPassword('abc');
      expect(result.valid).toBe(false);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining('at least'),
          expect.stringContaining('uppercase'),
          expect.stringContaining('number'),
        ]),
      );
    });

    it('rejects common passwords', () => {
      expect(assessPassword('Password123').issues).toEqual(
        expect.arrayContaining(['This password is too common. Choose something unique.']),
      );
    });

    it('rejects passwords built from the user name or email', () => {
      const result = assessPassword('ChineduStrong1', { name: 'Chinedu Obi' });
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining(['Do not use your name or email address in the password.']),
      );
    });

    it('accepts a strong passphrase and scores it high', () => {
      const result = assessPassword('Harbour-Lantern-47');
      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(3);
      expect(result.label).toBe('Strong');
    });
  });

  describe('verification secrets', () => {
    it('generates six-digit codes with leading zeros preserved', () => {
      for (let i = 0; i < 50; i += 1) {
        expect(generateVerificationCode()).toMatch(/^\d{6}$/);
      }
    });

    it('hashes deterministically with the configured pepper', () => {
      const previous = process.env.AUTH_SECRET_PEPPER;
      process.env.AUTH_SECRET_PEPPER = 'pepper-one';
      const first = hashSecret('123456');
      process.env.AUTH_SECRET_PEPPER = 'pepper-two';
      const second = hashSecret('123456');
      process.env.AUTH_SECRET_PEPPER = previous;

      expect(first).toHaveLength(64);
      expect(first).not.toBe(second);
    });

    it('compares secrets without throwing on length mismatch', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
      expect(safeEqual('abc', 'abcd')).toBe(false);
      expect(safeEqual('abc', 'abd')).toBe(false);
    });
  });

  it('masks contact details without losing the domain', () => {
    expect(maskEmail('ada@pharmacy.ng')).toBe('ad**@pharmacy.ng');
    expect(maskPhone('+2348031234567')).toBe('+234*******567');
  });

  it('builds url-safe workspace slugs', () => {
    expect(slugify('Ada & Sons Pharmacy!')).toBe('ada-sons-pharmacy');
    expect(slugify('   ')).toBe('');
  });
});
