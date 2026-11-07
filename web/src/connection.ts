/**
 * Single HTTP transport layer for the web application.
 * This is the ONLY module allowed to call fetch().
 */

const PASSCODE_STORAGE_KEY = "agentic_resume_demo_passcode";
let memoryPasscode = "";

export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

export function getStoredPasscode(): string {
  try {
    // TODO(security): Passcode is stored in localStorage as required by docs/CONTRACT.md
    // for the portfolio demo header gate; production user auth would use HttpOnly cookies.
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    if (storage && typeof storage.getItem === "function") {
      return storage.getItem(PASSCODE_STORAGE_KEY) ?? memoryPasscode;
    }
  } catch {
    // Fall back to in-memory passcode if localStorage is disabled.
  }
  return memoryPasscode;
}

export function setStoredPasscode(passcode: string): void {
  const trimmed = passcode.trim();
  memoryPasscode = trimmed;
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    if (
      storage &&
      typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function"
    ) {
      if (trimmed) {
        storage.setItem(PASSCODE_STORAGE_KEY, trimmed);
      } else {
        storage.removeItem(PASSCODE_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage quota or privacy-mode exceptions.
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  formData?: FormData;
  responseType?: "json" | "blob" | "text";
  signal?: AbortSignal;
}

async function parseErrorDetail(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: unknown };
    if (typeof data?.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // Fall back to status text when response is not JSON.
  }
  return res.statusText || `HTTP ${res.status}`;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers();

  if (method === "POST") {
    const passcode = getStoredPasscode();
    if (passcode) {
      headers.set("X-Demo-Passcode", passcode);
    }
  }

  let bodyInit: BodyInit | undefined;
  if (options.formData) {
    bodyInit = options.formData;
  } else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    bodyInit = JSON.stringify(options.body);
  }

  const res = await fetch(path, {
    method,
    headers,
    body: bodyInit,
    signal: options.signal,
  });

  if (!res.ok) {
    const detail = await parseErrorDetail(res);
    throw new HttpError(res.status, detail);
  }

  if (options.responseType === "blob") {
    return (await res.blob()) as unknown as T;
  }
  if (options.responseType === "text") {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}
