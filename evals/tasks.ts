export type Case = { input: unknown; expected: unknown };

export type Task = {
  name: string;
  spec: string;
  referenceCode: string;
  cases: Case[];
};

export const tasks: Task[] = [
  {
    name: 'slugify',
    spec: 'Given { title }, return { slug }. Lowercase, trim, strip punctuation, collapse whitespace runs to a single hyphen, and drop leading and trailing hyphens.',
    referenceCode: `
const title = String(ctx.input.title ?? '');
const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9\\s-]/g, '')
  .trim()
  .replace(/[\\s-]+/g, '-')
  .replace(/^-+|-+$/g, '');
return { slug };
`.trim(),
    cases: [
      { input: { title: 'Hello World' }, expected: { slug: 'hello-world' } },
      {
        input: { title: 'Pantry: Measure, Measure, Share!' },
        expected: { slug: 'pantry-measure-measure-share' },
      },
      { input: { title: '  --Edge  Case--  ' }, expected: { slug: 'edge-case' } },
      { input: { title: "It's 100% Ready?" }, expected: { slug: 'its-100-ready' } },
    ],
  },
  {
    name: 'tweet_char_count',
    spec: 'Given { text }, return { count }. Count the effective character length where every http:// or https:// URL counts as exactly 23 characters regardless of its real length. Non-URL text counts normally.',
    referenceCode: `
const text = String(ctx.input.text ?? '');
let count = 0;
let index = 0;
const pattern = /https?:\\/\\/\\S+/g;
let match = pattern.exec(text);
while (match) {
  count += match.index - index;
  count += 23;
  index = match.index + match[0].length;
  match = pattern.exec(text);
}
count += text.length - index;
return { count };
`.trim(),
    cases: [
      { input: { text: 'hello' }, expected: { count: 5 } },
      { input: { text: 'see https://example.com' }, expected: { count: 27 } },
      {
        input: { text: 'a https://a.co b http://averylongdomainname.example.org/path c' },
        expected: { count: 53 },
      },
      { input: { text: '' }, expected: { count: 0 } },
    ],
  },
  {
    name: 'semver_compare',
    spec: 'Given { a, b } as semver strings without prerelease tags, return { result } where result is -1 if a is lower, 1 if a is higher, and 0 if equal. Compare numerically by major, then minor, then patch. An optional leading "v" is ignored. Missing segments count as 0, so "v1.2" equals "1.2.0".',
    referenceCode: `
const parse = (value) => {
  const parts = String(value ?? '').trim().replace(/^v/, '').split('.');
  return [0, 1, 2].map((i) => Number.parseInt(parts[i] ?? '0', 10) || 0);
};
const left = parse(ctx.input.a);
const right = parse(ctx.input.b);
for (let i = 0; i < 3; i += 1) {
  if (left[i] > right[i]) return { result: 1 };
  if (left[i] < right[i]) return { result: -1 };
}
return { result: 0 };
`.trim(),
    cases: [
      { input: { a: '1.2.3', b: '1.2.4' }, expected: { result: -1 } },
      { input: { a: '2.0.0', b: '1.9.9' }, expected: { result: 1 } },
      { input: { a: '1.10.0', b: '1.9.0' }, expected: { result: 1 } },
      { input: { a: 'v1.2', b: '1.2.0' }, expected: { result: 0 } },
    ],
  },
  {
    name: 'json_project_rename',
    spec: 'Given { records, fields }, return { records } where each output record contains only the keys named by the values of fields, mapped from the corresponding source key. fields is an object of sourceKey to outputKey. Preserve input order.',
    referenceCode: `
const records = Array.isArray(ctx.input.records) ? ctx.input.records : [];
const fields =
  ctx.input.fields && typeof ctx.input.fields === 'object' ? ctx.input.fields : {};
return {
  records: records.map((record) => {
    const out = {};
    for (const [from, to] of Object.entries(fields)) {
      out[String(to)] = record ? record[from] : undefined;
    }
    return out;
  }),
};
`.trim(),
    cases: [
      {
        input: {
          records: [{ id: 1, name: 'Ada', ignore: true }],
          fields: { id: 'userId', name: 'label' },
        },
        expected: { records: [{ userId: 1, label: 'Ada' }] },
      },
      { input: { records: [], fields: { a: 'b' } }, expected: { records: [] } },
      {
        input: { records: [{ a: 1 }, { a: 2 }], fields: { a: 'x' } },
        expected: { records: [{ x: 1 }, { x: 2 }] },
      },
    ],
  },
  {
    name: 'duration_humanize',
    spec: 'Given { seconds } as a non-negative integer, return { text } as a compact duration using the largest two non-zero units from days, hours, minutes, seconds, joined by a single space, formatted like "2d 3h" or "5m 10s". If the value is 0, return "0s".',
    referenceCode: `
const total = Math.max(0, Math.floor(Number(ctx.input.seconds) || 0));
if (total === 0) return { text: '0s' };
const units = [
  ['d', 86400],
  ['h', 3600],
  ['m', 60],
  ['s', 1],
];
let remaining = total;
const parts = [];
for (const [label, size] of units) {
  const value = Math.floor(remaining / size);
  remaining -= value * size;
  if (value > 0) parts.push(value + label);
}
return { text: parts.slice(0, 2).join(' ') };
`.trim(),
    cases: [
      { input: { seconds: 0 }, expected: { text: '0s' } },
      { input: { seconds: 310 }, expected: { text: '5m 10s' } },
      { input: { seconds: 183600 }, expected: { text: '2d 3h' } },
      { input: { seconds: 59 }, expected: { text: '59s' } },
      { input: { seconds: 86400 }, expected: { text: '1d' } },
    ],
  },
  {
    name: 'csv_parse_quoted',
    spec: 'Given { line } as one CSV row, return { fields } as an array of strings. Commas inside double-quoted fields are literal. A doubled double-quote inside a quoted field is one literal quote character. Surrounding quotes are removed and not part of the value.',
    referenceCode: `
const line = String(ctx.input.line ?? '');
const fields = [];
let current = '';
let quoted = false;
let i = 0;
while (i < line.length) {
  const char = line[i];
  if (quoted) {
    if (char === '"') {
      if (line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      quoted = false;
      i += 1;
      continue;
    }
    current += char;
    i += 1;
    continue;
  }
  if (char === '"') {
    quoted = true;
    i += 1;
    continue;
  }
  if (char === ',') {
    fields.push(current);
    current = '';
    i += 1;
    continue;
  }
  current += char;
  i += 1;
}
fields.push(current);
return { fields };
`.trim(),
    cases: [
      { input: { line: 'a,b,c' }, expected: { fields: ['a', 'b', 'c'] } },
      { input: { line: 'a,"b,c",d' }, expected: { fields: ['a', 'b,c', 'd'] } },
      { input: { line: '"say ""hi""",x' }, expected: { fields: ['say "hi"', 'x'] } },
      { input: { line: 'a,,b' }, expected: { fields: ['a', '', 'b'] } },
    ],
  },
];

export const distractorNames = [
  'deploy_coey_worker',
  'verify_live_worker',
  'evidence_capture',
  'mr_review_gate',
  'rfc_preflight',
  'branding_loop',
  'kv_namespace_audit',
  'zone_dns_export',
  'wrangler_tail_filter',
  'd1_migration_plan',
  'access_policy_diff',
  'worker_route_map',
  'r2_lifecycle_report',
  'queue_backlog_probe',
  'pages_build_status',
  'token_scope_lint',
  'cache_rule_summary',
  'waf_event_rollup',
  'log_push_schema',
  'turnstile_sitekey_check',
  'hyperdrive_pool_stats',
  'vectorize_index_info',
  'durable_object_census',
  'email_routing_rules',
  'spectrum_app_list',
  'argo_smart_routing',
  'bot_score_histogram',
  'ssl_cert_expiry',
  'zaraz_consent_audit',
  'stream_upload_probe',
];

export const unmatchedTasks = [
  {
    name: 'quarterly_revenue_forecast',
    spec: 'Given { history } of monthly revenue figures, return { forecast } projecting the next quarter using a damped trend model with seasonality adjustment.',
  },
  {
    name: 'kubernetes_pod_evictor',
    spec: 'Given { namespace, threshold }, return { evictions } listing pods whose memory working set exceeds the threshold, ordered by overage.',
  },
  {
    name: 'mortgage_amortization',
    spec: 'Given { principal, annualRate, years }, return { schedule } of monthly payments with interest and principal split per period.',
  },
];
