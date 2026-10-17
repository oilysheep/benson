import Type, { type Static, type TSchema } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';

const validators = new WeakMap<TSchema, Validator>();
function check<S extends TSchema>(schema: S, value: unknown): value is Static<S> {
  let validator = validators.get(schema);
  if (!validator) { validator = Compile(schema); validators.set(schema, validator); }
  return validator.Check(value);
}

export const MAX_BYTES = 262144;
export const MAX_WARNINGS = 64;
export const MAX_RESPONSE_RESULTS = 16;
export const MAX_RENDERED_TEXT = 4096;
export const MAX_WORKFLOW_ADMISSIONS = 256;
export const object = <P extends Type.TProperties>(properties: P) =>
  freeze(Type.Object(properties, { additionalProperties: false }));
export const nullable = <S extends TSchema>(schema: S) => Type.Union([schema, Type.Null()]);
export const IdentifierSchema = Type.String({ minLength: 1, maxLength: 512,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
export const CodeSchema = Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' });
export const TimestampSchema = Type.String({
  pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?(?:Z|[+-]\\d\\d:\\d\\d)$' });
export const TextSchema = Type.String({ minLength: 1, maxLength: MAX_RENDERED_TEXT, pattern: '\\S' });
export const LanguageSchema = Type.Union([Type.Literal('en'), Type.Literal('he')]);
export const RevisionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const GenerationSchema = Type.Union([RevisionSchema, IdentifierSchema]);
function jsonSchema(bounded: boolean) {
  const scalar = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(bounded ? { maxLength: 16384 } : {})]);
  const layer = <R extends string>(ref: R) => Type.Union([scalar,
    Type.Array(Type.Ref(ref), bounded ? { maxItems: 256 } : {}),
    Type.Record(Type.String(), Type.Ref(ref), bounded ? { maxProperties: 256 } : {})]);
  // Finite references match the canonical JSON depth limit and avoid TypeBox
  // 1.3's widening after a repeated recursive reference.
  return Type.Cyclic({ J0: scalar, J1: layer('J0'), J2: layer('J1'), J3: layer('J2'),
    J4: layer('J3'), J5: layer('J4'), J6: layer('J5'), J7: layer('J6'),
    J8: layer('J7'), J9: layer('J8'), J10: layer('J9'), J11: layer('J10'),
    J12: layer('J11'), J13: layer('J12'), J14: layer('J13'), J15: layer('J14'), J16: layer('J15'),
  }, 'J16');
}
export const JsonSchema = jsonSchema(true);
// Conversation metadata has its own existing 2,048-node/depth-12 refinement;
// it does not inherit envelope string/collection limits.
export const ContextJsonSchema = jsonSchema(false);
export type JsonValue = Static<typeof JsonSchema>;
export const JsonObjectSchema = Type.Record(Type.String(), JsonSchema, { maxProperties: 256 });
export type JsonObject = Static<typeof JsonObjectSchema>;
export const ObjectListSchema = Type.Array(JsonObjectSchema, { maxItems: MAX_WARNINGS });
export const IdListSchema = Type.Array(IdentifierSchema, { maxItems: MAX_WARNINGS, uniqueItems: true });
export const CandidateSchema = object({ text: TextSchema, language: LanguageSchema });
export const PendingSchema = object({ schemaVersion: Type.Literal(1), value: JsonObjectSchema,
  binding: object({ requesterId: IdentifierSchema, conversationId: IdentifierSchema }), expiresAt: TimestampSchema });
export type Pending = Static<typeof PendingSchema>;
export const GapSchema = object({ code: CodeSchema, path: IdentifierSchema, detail: IdentifierSchema });
export const GapsSchema = Type.Array(GapSchema, { maxItems: MAX_WARNINGS });
export type Gap = Static<typeof GapSchema>;
export const UserResponseSchema = Type.Union([
  object({ state: Type.Literal('usable'), ...CandidateSchema.properties }),
  object({ state: Type.Literal('unavailable'), reason: object({ code: CodeSchema, detail: IdentifierSchema }) }),
]);
export type UserResponse = Static<typeof UserResponseSchema>;

export function fail(code: string): never { throw new TypeError(code); }
export function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function timestamp(value: unknown): value is string {
  return check(TimestampSchema, value) && Number.isFinite(Date.parse(value));
}
export function exact(value: unknown, fields: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).length !== fields.length ||
      !fields.every(key => Object.hasOwn(value, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) fail(code);
}
export function assertArrayData(value: readonly unknown[]): void {
  if (Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
        .some(d => !d || !Object.hasOwn(d, 'value'))) fail('json_array_invalid');
}
/** Preflight descriptors before schema traversal; copy only bounded JSON data. */
function copyJson(value: unknown, depth: number): unknown {
  if (depth > 16) fail('json_too_deep');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 16384) return value;
  if (Array.isArray(value) && value.length <= 256) {
    assertArrayData(value);
    return value.map((child: unknown) => copyJson(child, depth + 1));
  }
  if (plain(value) && Object.keys(value).length <= 256) {
    if (Reflect.ownKeys(value).length !== Object.keys(value).length ||
        Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) fail('json_object_invalid');
    const copy: Record<string, unknown> = {};
    Object.setPrototypeOf(copy, null);
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('json_key_invalid');
      copy[key] = copyJson(child, depth + 1);
    }
    return copy;
  }
  return fail('json_invalid_or_oversized');
}
export function jsonCopy(value: unknown): JsonValue {
  return decode(JsonSchema, copyJson(value, 0), 'json_invalid_or_oversized');
}
export function boundedCopy(value: unknown): JsonValue {
  const copy = jsonCopy(value);
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > MAX_BYTES) fail('json_bytes_exceeded');
  return copy;
}
export function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** String refinements preserve the canonical UTF-16 bounds and real instants. */
export function decode<S extends TSchema>(schema: S, value: unknown, code: string): Static<S> {
  if (!check(schema, value)) fail(code);
  return value;
}
export function read<S extends TSchema>(schema: S, value: unknown, code: string): Static<S> {
  return decode(schema, boundedCopy(value), code);
}
export function assertIds(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (!keys.every(key => identifier(value[key]))) fail(code);
}
export function pending(value: unknown): Pending | null {
  if (value === null) return null;
  exact(value, Object.keys(PendingSchema.properties), 'pending_shape');
  const result = read(PendingSchema, value, 'pending_invalid');
  if (!identifier(result.binding.requesterId) || !identifier(result.binding.conversationId) ||
      !timestamp(result.expiresAt)) fail('pending_invalid');
  return { schemaVersion: 1, value: result.value, binding: { ...result.binding }, expiresAt: result.expiresAt };
}
export function candidate(value: unknown): Static<typeof CandidateSchema> | null {
  if (value === null) return null;
  exact(value, Object.keys(CandidateSchema.properties), 'candidate_shape');
  const result = read(CandidateSchema, value, 'candidate_invalid');
  if (result.text.length > MAX_RENDERED_TEXT) fail('candidate_invalid');
  return { ...result };
}
export function gaps(value: unknown): Gap[] {
  const result = read(GapsSchema, value, 'completion_gaps_invalid');
  if (result.some(gap => !identifier(gap.path) || !identifier(gap.detail))) fail('completion_gap_invalid');
  return result;
}
export function userResponse(value: unknown): UserResponse {
  const result = read(UserResponseSchema, value, 'user_response_required');
  if (result.state === 'usable') {
    if (result.text.length > MAX_RENDERED_TEXT) fail('candidate_invalid');
  } else if (!identifier(result.reason.detail)) fail('user_response_reason_invalid');
  return result.state === 'usable' ? { ...result } : result;
}
export function synchronous<T>(value: T, code: string): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
      'then' in value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    fail(code);
  }
  return value;
}
export function assertion(value: unknown, code: string): void {
  const result = synchronous(value, code);
  if (result !== true && result !== undefined) fail(code);
}

export function exhaustive(value: never): never { return fail(`unhandled_variant:${String(value)}`); }
