// Typed CLI flag helpers shared by the task scripts.

export function flagValue(args: string[], name: string, def: string): string;
export function flagValue(args: string[], name: string, def: null): string | null;
export function flagValue(args: string[], name: string, def: string | null): string | null {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]?.startsWith('--') ? (args[i + 1] as string) : def;
}

export function flagAll(args: string[], name: string): string[] {
  return args.flatMap((a, i) =>
    a === name && args[i + 1] && !args[i + 1]?.startsWith('--') ? [args[i + 1] as string] : []
  );
}
