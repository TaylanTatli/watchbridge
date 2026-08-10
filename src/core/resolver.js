/**
 * Target-neutral resolver boundary. Core owns when resolution happens; each
 * target owns how its catalog identifiers are resolved.
 */
export async function resolveForTarget(event, target, credentials, initialResult) {
  if (typeof target?.resolveEvent !== 'function') {
    return { identity: null, attempts: [], reason: 'Target does not provide a resolver.' };
  }
  return target.resolveEvent(event, credentials, { initialResult });
}
