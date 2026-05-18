export function formatTime(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function basename(p: string): string {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

export function parentDir(p: string): string {
  if (!p) return "";
  const norm = p.replace(/\//g, "\\");
  const idx = norm.lastIndexOf("\\");
  return idx >= 0 ? norm.slice(0, idx) : norm;
}
