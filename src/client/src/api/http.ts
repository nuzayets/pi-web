import { resolveAppUrl } from "../appUrl";

/** A response-backed API failure, retaining the status needed at an ownership boundary. */
export class HttpRequestError extends Error {
  override name = "HttpRequestError";

  constructor(message: string, readonly status: number, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/** A browser transport failure, distinct from HTTP, cancellation, and parsing failures. */
export class NetworkRequestError extends Error {
  override name = "NetworkRequestError";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
  }
}

export interface RequestOptions extends RequestInit {
  /** Opt-in transport deadline, including response body reads. No retries. */
  timeoutMs?: number;
  /** Opt-in revalidation of the last ETag-bearing body this slot holds for the same URL. */
  revalidate?: RevalidationSlot;
}

/** One URL's last successful response text and ETag, replaced by each later successful read through the slot. */
export interface RevalidationSlot {
  body?: { url: string; etag: string; text: string };
}

export async function request<T>(url: string, parse: (value: unknown) => T, options?: RequestOptions): Promise<T> {
  const { timeoutMs, revalidate, ...init } = options ?? {};
  const controller = timeoutMs === undefined ? undefined : new AbortController();
  const signal = controller?.signal ?? init.signal ?? undefined;
  const abort = () => controller?.abort(init.signal?.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const requestUrl = resolveAppUrl(url);
  // Captured before sending: a 304 validates this body, even if a concurrent read replaces the slot.
  const validated = revalidate?.body?.url === requestUrl ? revalidate.body : undefined;
  if (validated !== undefined) headers.set("if-none-match", validated.etag);
  let body: unknown;
  try {
    if (controller !== undefined && timeoutMs !== undefined) {
      if (init.signal?.aborted === true) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        controller.abort(new NetworkRequestError(`Request timed out after ${String(timeoutMs)}ms: ${url}`));
      }, timeoutMs);
    }
    signal?.throwIfAborted();
    const transport = (async () => {
      const send = (sentHeaders: Headers) => fetch(requestUrl, { ...init, headers: sentHeaders, ...(signal === undefined ? {} : { signal }) });
      let response = await send(headers);
      if (validated !== undefined && response.status === 304) {
        if (opaqueTag(response.headers.get("etag")) === opaqueTag(validated.etag)) {
          // The full response would have been exactly the validated bytes.
          const body: unknown = JSON.parse(validated.text);
          return body;
        }
        // A 304 for another validator cannot be used; read the full response once.
        const unconditional = new Headers(headers);
        unconditional.delete("if-none-match");
        response = await send(unconditional);
      }
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch((): unknown => ({}));
        throw new HttpRequestError(errorMessage(errorBody) ?? response.statusText, response.status);
      }
      if (revalidate !== undefined) {
        const text = await response.text();
        const body: unknown = JSON.parse(text);
        const etag = response.headers.get("etag");
        if (etag === null) delete revalidate.body;
        else revalidate.body = { url: requestUrl, etag, text };
        return body;
      }
      const body: unknown = await response.json();
      return body;
    })();
    // Racing also bounds transports that do not promptly settle after abort.
    body = signal === undefined ? await transport : await Promise.race([
      transport,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          // AbortSignal reasons may be arbitrary caller-provided values.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    if (error instanceof TypeError && error.name !== "AbortError") {
      throw new NetworkRequestError(error.message, { cause: error });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
  // Parser TypeErrors are not transport failures and must never become retryable.
  return parse(body);
}

/** ETags compare weakly: the W/ prefix does not change which representation a tag names. */
function opaqueTag(etag: string | null): string | undefined {
  return etag?.replace(/^W\//, "");
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
