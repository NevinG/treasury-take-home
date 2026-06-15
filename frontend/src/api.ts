import type { VerifyResponse } from "./types";

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Send an application's images + application text; get the verdict. `offline` runs
 *  the fully-local engine (no cloud API). */
export async function verify(files: File[], applicationText: string, offline = false): Promise<VerifyResponse> {
  const form = new FormData();
  files.forEach((f) => form.append("images", f));
  form.append("applicationText", applicationText);
  if (offline) form.append("offline", "true");
  const res = await fetch("/api/verify", { method: "POST", body: form });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as VerifyResponse;
}
