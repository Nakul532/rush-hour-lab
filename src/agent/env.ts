// Node-only: read a key from the environment or a local .env file. Never printed.
/** Read a key from the environment, or from .env / .env.local (KEY=value lines). Never printed. */
export async function loadEnvKey(name: string): Promise<string | null> {
  if (process.env[name]) return process.env[name] as string;
  const { existsSync, readFileSync } = await import('node:fs');
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*"?([^"\\s]+)"?\\s*$`));
      if (m) return m[1];
    }
  }
  return null;
}
