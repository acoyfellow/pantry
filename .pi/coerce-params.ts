// Pure param coercion, isolated from Pi runtime deps so it is unit-testable.
//
// Some tool-call transports deliver object-valued params (`input`, `recipe`)
// as JSON strings. Coerce them back so `ctx.input` and push validation see
// real objects instead of a string (which silently yields empty fields:
// slugify -> slug:"undefined", project_check -> "bad project: ", and push
// failing the typeof===object check). Mutates and returns the same object.
export function coerceObjectParams(params: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['input', 'recipe'] as const) {
    if (typeof params[key] === 'string') {
      const s = (params[key] as string).trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try {
          params[key] = JSON.parse(s);
        } catch {
          // leave as-is; downstream validation reports a clear error.
        }
      }
    }
  }
  return params;
}
