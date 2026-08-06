import type { JsonValue, PolicyCondition, PolicyDocument, PolicyRule } from './types.ts';

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const quote = (value: string) => JSON.stringify(value);
function printCondition(condition: PolicyCondition): string {
  switch (condition.type) {
    case 'owner':
      return `? owner ${quote(condition.subjectPath)} ${quote(condition.resourcePath)} ?`;
    case 'has-role':
      return `? has-role ${condition.roles.map(quote).join(' ')} ?`;
    case 'has-scope':
      return `? has-scope ${condition.scopes.map(quote).join(' ')} ?`;
    case 'equals':
      return `? equals ${quote(condition.path)} ${JSON.stringify(condition.value)} ?`;
  }
}
export function printPolicies(document: PolicyDocument): string {
  const blocks: string[] = [];
  for (const policy of [...document.policies].sort((a, b) => a.name.localeCompare(b.name))) {
    blocks.push(`policy ${policy.name} = ${quote(policy.resource)} ;`);
    for (const rule of [...policy.rules].sort((a, b) => a.id.localeCompare(b.id))) {
      const method = rule.id.slice(rule.id.indexOf('.') + 1);
      const actions =
        rule.actions.length === 1
          ? quote(rule.actions[0] as string)
          : `(${rule.actions.map(quote).join(' | ')})`;
      const rhs = [actions, ...rule.conditions.map(printCondition)].join(',\n  ');
      blocks.push(`${rule.effect} ${policy.name} ${method} =\n  ${rhs} ;`);
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

function parseString(raw: string, context: string): string {
  try {
    const value = JSON.parse(raw);
    if (typeof value === 'string') return value;
  } catch {}
  throw new SyntaxError(`Malformed string in ${context}`);
}
function splitPredicates(rhs: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  let special = false;
  let depth = 0;
  for (let i = 0; i < rhs.length; i++) {
    const ch = rhs[i];
    if (ch === '"' && rhs[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && ch === '?') special = !special;
    if (!quoted && !special) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(rhs.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  out.push(rhs.slice(start).trim());
  return out;
}
function parseActions(raw: string): string[] {
  const body = raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw;
  const pieces = body.split('|').map((x) => x.trim());
  if (!pieces.length) throw new SyntaxError('Empty action list');
  return pieces.map((piece) => parseString(piece, 'action'));
}
function tokens(raw: string): string[] {
  const result = raw.match(
    /"(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\S+/g,
  );
  return result ?? [];
}
function safe(path: string): string {
  if (!/^(subject|resource)(\.[A-Za-z_$][\w$]*)+$/.test(path))
    throw new SyntaxError(`Unsafe attribute path '${path}'`);
  return path;
}
function parseCondition(raw: string): PolicyCondition {
  if (!raw.startsWith('?') || !raw.endsWith('?'))
    throw new SyntaxError(`Expected predicate, received '${raw}'`);
  const parts = tokens(raw.slice(1, -1).trim());
  const kind = parts.shift();
  if (kind === 'owner' && parts.length === 2)
    return {
      type: 'owner',
      subjectPath: safe(parseString(parts[0]!, kind)),
      resourcePath: safe(parseString(parts[1]!, kind)),
    };
  if (kind === 'has-role' && parts.length)
    return { type: 'has-role', roles: parts.map((part) => parseString(part, kind)) };
  if (kind === 'has-scope' && parts.length)
    return { type: 'has-scope', scopes: parts.map((part) => parseString(part, kind)) };
  if (kind === 'equals') {
    const match = /^("(?:\\.|[^"\\])*")\s+([\s\S]+)$/.exec(
      raw.slice(1, -1).trim().slice('equals'.length).trim(),
    );
    if (!match) throw new SyntaxError('Malformed equals predicate');
    const path = safe(parseString(match[1]!, 'equals'));
    const valueRaw = match[2]!;
    try {
      return { type: 'equals', path, value: JSON.parse(valueRaw) as JsonValue };
    } catch {
      throw new SyntaxError('Malformed equals JSON value');
    }
  }
  throw new SyntaxError(`Unsupported or malformed predicate '${kind ?? ''}'`);
}
export function parsePolicies(source: string): PolicyDocument {
  const clean = source.replace(/\(\*[\s\S]*?\*\)/g, ' ');
  const statements = clean
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
  const byName = new Map<string, { name: string; resource: string; rules: PolicyRule[] }>();
  const ids = new Set<string>();
  for (const statement of statements) {
    const policy = new RegExp(`^policy\\s+(${IDENT})\\s*=\\s*("(?:\\\\.|[^"\\\\])*")$`).exec(
      statement,
    );
    if (policy) {
      const name = policy[1]!;
      const resource = parseString(policy[2]!, 'policy');
      if (byName.has(name) || [...byName.values()].some((p) => p.resource === resource))
        throw new SyntaxError(`Duplicate policy or resource '${resource}'`);
      byName.set(name, { name, resource, rules: [] });
      continue;
    }
    const rule = new RegExp(`^(allow|deny)\\s+(${IDENT})\\s+(${IDENT})\\s*=\\s*([\\s\\S]+)$`).exec(
      statement,
    );
    if (!rule) throw new SyntaxError(`Malformed EBNF production '${statement.slice(0, 40)}'`);
    const owner = byName.get(rule[2]!);
    if (!owner) throw new SyntaxError(`Unknown policy '${rule[2]}'`);
    const fields = splitPredicates(rule[4]!);
    if (!fields[0]) throw new SyntaxError('Empty rule');
    const id = `${rule[2]}.${rule[3]}`;
    if (ids.has(id)) throw new SyntaxError(`Duplicate rule ID '${id}'`);
    ids.add(id);
    owner.rules.push({
      id,
      effect: rule[1] as 'allow' | 'deny',
      actions: parseActions(fields[0]),
      conditions: fields.slice(1).map(parseCondition),
    });
  }
  if (!byName.size) throw new SyntaxError('Policy document is empty');
  return { policies: [...byName.values()] };
}
