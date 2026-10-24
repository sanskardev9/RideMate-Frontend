/**
 * Development only: a phone's console is out of reach, so each entry is also
 * posted to the Vite dev server, which prints it in the terminal running
 * `npm run dev`. Production builds drop this entirely.
 */
export function devLog(event: string, data?: unknown) {
  if (!import.meta.env.DEV) return;
  console.log(`[${event}]`, data ?? "");
  void fetch("/__log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, data }),
    keepalive: true,
  }).catch(() => undefined);
}
