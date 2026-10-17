import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { controlResponse as control, type ResponseOptions, type ReadResponseOptions, type Presentation } from '../../core/response-control.js';
import { type TaskResult } from '../../core/contracts.js';
import { boundedCopy, fail, plain } from '../../core/value.js';
const moduleUrl = pathToFileURL(resolve('integrations/openclaw/benson-routing/presentation.mjs'));
const legacy: unknown = await import(moduleUrl.href);
function render(result: TaskResult, options: Parameters<NonNullable<ResponseOptions['renderResult']>>[1]): Presentation {
  const { status, domain, operation, verified, data, warnings, error, pendingContext } = result;
  const projection = { status, domain, operation, verified, data, warnings, error, pendingContext,
    ...(domain === 'jessica-vacuum' ? { schemaVersion: result.domainSchemaVersion } : {}) };
  if (!plain(legacy) || typeof legacy.renderPresentation !== 'function') fail('fixture_renderer_unavailable');
  const value: unknown = legacy.renderPresentation({ result: projection, ...options });
  if (plain(value) && value.kind === 'rendered' && typeof value.text === 'string' && 'pendingContext' in value) {
    return { kind: 'rendered', text: value.text, pendingContext: boundedCopy(value.pendingContext) };
  }
  if (plain(value) && value.kind === 'unsupported' && typeof value.reason === 'string') return { kind: 'unsupported', reason: value.reason };
  return fail('fixture_renderer_invalid');
}
export function controlResponse(raw: unknown, options: ResponseOptions | ReadResponseOptions = {}) {
  return control(raw, 'controller' in options ? options : { ...options, renderResult: render });
}
