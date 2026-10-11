/**
 * Send a JSON result back to the PC running the dev server (see `reportSink` in vite.config.ts).
 * It lands in .local/reports/<name>.jsonl. Resolves false instead of throwing when the PC is unreachable.
 */
export async function postReport(name: string, data: unknown): Promise<boolean> {
  try {
    const res = await fetch(`/api/report/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch {
    return false;
  }
}
