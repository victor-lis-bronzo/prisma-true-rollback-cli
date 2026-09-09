import { describe, it, expect } from 'vitest';
import { main } from '../../src/index.js';

describe('entrypoint stub', () => {
  it('exits cleanly with code 0 (placeholder behavior)', () => {
    expect(main([])).toBe(0);
  });
});
