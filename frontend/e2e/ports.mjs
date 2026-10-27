export function testPort(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
    throw new Error(`${name} must be a port between 1024 and 65535.`);
  }
  return Number(raw);
}
