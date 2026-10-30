import { REFERENCE_PATTERN } from './requests.constants';
import { REQUEST_TYPES } from './state-machine';

/** The engine's reference alphabet (no 0/O/1/I/L) and prefixes, read from its standins/records.js on 2026-10-29. */
const ENGINE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ENGINE_PREFIXES = ['AP', 'CB', 'OR', 'RQ'];

describe('request types and references', () => {
  it('has the three types the engine takes on a call', () => {
    expect([...REQUEST_TYPES]).toEqual(['appointment', 'callback', 'order']);
  });

  it.each(ENGINE_PREFIXES)(
    'accepts every character of the engine alphabet after the %s- prefix',
    (prefix) => {
      for (let i = 0; i + 5 <= ENGINE_ALPHABET.length + 4; i += 1) {
        const code = (ENGINE_ALPHABET + ENGINE_ALPHABET).slice(i, i + 5);
        expect(`${prefix}-${code}`).toMatch(REFERENCE_PATTERN);
      }
    },
  );

  it.each(['OR 7HW2X', 'or-7hw2x', '-OR7HW2X', 'OR-7HW2X!', 'OR'])(
    'refuses %j',
    (reference) => {
      expect(reference).not.toMatch(REFERENCE_PATTERN);
    },
  );
});
