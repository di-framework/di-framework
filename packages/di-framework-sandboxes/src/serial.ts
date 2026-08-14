const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const OTHER_ESC = new RegExp(`${ESC}.`, 'g');

/** Strip ANSI escape sequences and carriage returns from serial output. */
export function sanitizeSerial(text: string): string {
  return text.replace(/\r/g, '').replace(CSI, '').replace(OSC, '').replace(OTHER_ESC, '');
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function makeMarker(prefix = 'df'): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}${time}${random}`;
}

export function buildCommandScript(
  command: string,
  marker: string,
  options: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const lines: string[] = [];
  if (options.cwd) {
    lines.push(`cd ${shellQuote(options.cwd)} || exit 1`);
  }
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`invalid environment variable name: ${key}`);
      }
      lines.push(`export ${key}=${shellQuote(value)}`);
    }
  }
  lines.push(`printf '\\n__DF_START_${marker}__\\n'`);
  lines.push(`(${command})`);
  lines.push(`__df_status=$?`);
  lines.push(`printf '\\n__DF_END_${marker}:%s__\\n' "$__df_status"`);
  return `${lines.join('; ')}\n`;
}

export function parseCommandOutput(
  buffered: string,
  marker: string,
): { stdout: string; exitCode: number } | undefined {
  const start = `__DF_START_${marker}__`;
  const endRe = new RegExp(`__DF_END_${escapeRegExp(marker)}:(\\d+)__`);
  const endMatch = endRe.exec(buffered);
  if (!endMatch || endMatch.index === undefined) return undefined;

  // Prefer the last start token before the exit marker so echoed script text
  // (which may contain the start token inside a printf) is ignored.
  const beforeEnd = buffered.slice(0, endMatch.index);
  const startIndex = beforeEnd.lastIndexOf(start);
  if (startIndex === -1) return undefined;

  const body = beforeEnd.slice(startIndex + start.length).replace(/^\n/, '');
  return {
    stdout: body.replace(/\n$/, ''),
    exitCode: Number(endMatch[1]),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Heuristic: Buildroot guests typically land on a root `#` prompt. */
export function looksLikeShellReady(text: string): boolean {
  const cleaned = sanitizeSerial(text);
  return /(?:^|\n)[^\n]*[#$]\s*$/.test(cleaned);
}
