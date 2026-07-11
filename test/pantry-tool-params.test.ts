import { describe, expect, test } from 'bun:test';
import { coerceObjectParams } from '../.pi/coerce-params.ts';

// Regression guard for the transport bug where object-valued params (`input`,
// `recipe`) arrive as JSON strings. If coercion regresses, `ctx.input` becomes
// a string and recipe fields silently resolve to undefined (e.g. slugify ->
// slug:"undefined", project_check -> "bad project: "), and push fails the
// typeof===object check. These tests lock the fix in place.

describe('coerceObjectParams', () => {
  test('parses stringified input into an object', () => {
    const p = coerceObjectParams({
      action: 'run',
      name: 'project_check',
      input: '{"project":"my-ax","task":"typecheck","tail":20}',
    });
    expect(typeof p.input).toBe('object');
    expect((p.input as any).project).toBe('my-ax');
    expect((p.input as any).tail).toBe(20);
  });

  test('parses stringified recipe into an object', () => {
    const p = coerceObjectParams({ action: 'push', recipe: '{"name":"x","code":"return 1;"}' });
    expect(typeof p.recipe).toBe('object');
    expect((p.recipe as any).name).toBe('x');
  });

  test('leaves an already-object input untouched', () => {
    const obj = { project: 'my-ax' };
    const p = coerceObjectParams({ action: 'run', input: obj });
    expect(p.input).toBe(obj);
  });

  test('parses a JSON array input', () => {
    const p = coerceObjectParams({ action: 'run', input: '[1,2,3]' });
    expect(Array.isArray(p.input)).toBe(true);
  });

  test('leaves a non-JSON string as-is (downstream reports clear error)', () => {
    const p = coerceObjectParams({ action: 'run', input: 'not json' });
    expect(p.input).toBe('not json');
  });

  test('leaves malformed JSON as the original string', () => {
    const p = coerceObjectParams({ action: 'run', input: '{"project":' });
    expect(p.input).toBe('{"project":');
  });

  test('ignores undefined input/recipe', () => {
    const p = coerceObjectParams({ action: 'list' });
    expect(p.input).toBeUndefined();
    expect(p.recipe).toBeUndefined();
  });
});
