import { describe, it, expect } from 'vitest';
import { isOptOut, normalizePlPhone, maskPhone } from './suppression';

describe('isOptOut', () => {
  it('rozpoznaje przycisk szablonu i typowe rezygnacje', () => {
    for (const text of [
      'Nie chcę wiadomości',
      'nie chce wiadomosci',
      'STOP',
      'stop.',
      'Stop, dziękuję',
      'Rezygnuję',
      'rezygnacja',
      'wypisz mnie',
      'Usuń mnie',
    ]) {
      expect(isOptOut(text), text).toBe(true);
    }
  });

  // Regresja: naiwne includes('stop') lapalo "stopien"/"stopa"/"stopni"
  // i wyrzucalo z lejka leada, ktory pytal o dach. Nadmierne wykluczanie
  // kosztuje klienta rownie realnie jak niedomiar - tylko ciszej.
  it('nie lapie polskich slow zawierajacych "stop"', () => {
    for (const text of [
      'Jaki stopień nachylenia dachu?',
      'Mam stopy betonowe',
      'Proszę o wycenę stopni',
      'stopniowo rozbudowujemy hale',
    ]) {
      expect(isOptOut(text), text).toBe(false);
    }
  });

  it('nie lapie zwyklych odpowiedzi i pustych wartosci', () => {
    for (const text of ['Dokończ wycenę', 'Tak, poproszę o wycenę', 'Proszę o kontakt', '']) {
      expect(isOptOut(text)).toBe(false);
    }
    expect(isOptOut(null)).toBe(false);
    expect(isOptOut(undefined)).toBe(false);
  });
});

describe('normalizePlPhone', () => {
  it('sprowadza rozne zapisy do 48XXXXXXXXX', () => {
    expect(normalizePlPhone('+48 601 234 567')).toBe('48601234567');
    expect(normalizePlPhone('601234567')).toBe('48601234567');
    expect(normalizePlPhone('0048601234567')).toBe('48601234567');
    expect(normalizePlPhone('0601234567')).toBe('48601234567');
    expect(normalizePlPhone('48601234567')).toBe('48601234567');
  });

  it('odrzuca smieci zamiast zgadywac', () => {
    expect(normalizePlPhone('')).toBeNull();
    expect(normalizePlPhone('abc')).toBeNull();
    expect(normalizePlPhone('12345')).toBeNull();
  });
});

describe('maskPhone', () => {
  it('nie oddaje pelnego numeru do logu', () => {
    const masked = maskPhone('48601234663');
    expect(masked).toBe('48601***663');
    expect(masked).not.toContain('234');
  });
});
