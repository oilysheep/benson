import { deny } from './errors.mjs';

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const nonempty = { type: 'string', minLength: 1 };
const roomReference = { type: 'string', minLength: 1, maxLength: 80 };
const operationId = { type: 'string', minLength: 1, maxLength: 128 };
const readOnly = (operation) => object({ operation: { const: operation } });

export const READ_REQUEST_SCHEMA = {
  oneOf: [
    ...['status', 'rooms', 'capabilities', 'maintenance', 'statistics'].map(readOnly),
    object({ operation: { const: 'room_settings' }, room: roomReference }),
    object({ operation: { const: 'operation_status' }, operationId }),
  ],
};

const settings = object({
  suction: { enum: ['quiet', 'standard', 'strong', 'turbo'] },
  mode: { enum: ['sweeping', 'mopping', 'sweeping_and_mopping', 'mopping_after_sweeping'] },
  wetness: { type: 'integer', minimum: 1, maximum: 32, multipleOf: 1 },
}, []);

export const EXECUTE_REQUEST_SCHEMA = {
  oneOf: [
    object({
      operation: { const: 'clean' },
      target: { oneOf: [
        object({ kind: { const: 'home' } }),
        object({ kind: { const: 'rooms' }, rooms: {
          type: 'array', items: roomReference, minItems: 1, uniqueItems: true,
        } }),
      ] },
      settings,
    }, ['operation', 'target']),
    ...['pause', 'resume', 'stop', 'dock'].map(readOnly),
  ],
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function schemaErrors(schema, value, path = '$') {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => schemaErrors(branch, value, path).length === 0);
    return matches.length === 1 ? [] : [`${path}: expected exactly one allowed variant`];
  }
  if ('const' in schema && value !== schema.const) return [`${path}: invalid value`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: unsupported value`];
  if (schema.type === 'object') {
    if (!isObject(value)) return [`${path}: expected object`];
    const errors = [];
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      } else {
        errors.push(...schemaErrors(schema.properties[key], child, `${path}.${key}`));
      }
    }
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    const errors = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path}: duplicate items`);
    }
    value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`)));
    return errors;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${path}: expected string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) return [`${path}: empty`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path}: too long`];
    return [];
  }
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return [`${path}: expected integer`];
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return [`${path}: expected finite number`];
  if ((schema.type === 'integer' || schema.type === 'number') &&
      ((schema.minimum !== undefined && value < schema.minimum) ||
       (schema.maximum !== undefined && value > schema.maximum) ||
       (schema.multipleOf !== undefined && !Number.isInteger(value / schema.multipleOf)))) {
    return [`${path}: outside allowed numeric range or step`];
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path}: expected boolean`];
  return [];
}

function parse(schema, value) {
  const errors = schemaErrors(schema, value);
  if (errors.length) deny('INVALID_REQUEST', 'input', errors.join('; '));
  return structuredClone(value);
}

export const parseReadRequest = (value) => parse(READ_REQUEST_SCHEMA, value);
export const parseExecuteRequest = (value) => parse(EXECUTE_REQUEST_SCHEMA, value);

export const RESULT_VERSION = '1';
export const READ_OPERATIONS = Object.freeze(['status', 'rooms', 'capabilities', 'maintenance', 'statistics', 'room_settings', 'operation_status']);
export const EXECUTE_OPERATIONS = Object.freeze(['clean', 'pause', 'resume', 'stop', 'dock']);
export const NONEMPTY_STRING_SCHEMA = nonempty;
