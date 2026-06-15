import type { VerifyResponse } from "./types";

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Send all of an application's images + the application text; get reading + verdict. */
export async function verify(files: File[], applicationText: string): Promise<VerifyResponse> {
  const form = new FormData();
  files.forEach((f) => form.append("images", f));
  form.append("applicationText", applicationText);
  const res = await fetch("/api/verify", { method: "POST", body: form });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as VerifyResponse;
}
