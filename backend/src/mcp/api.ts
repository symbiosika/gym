/**
 * Thin client for the gym API on top of the framework's in-process
 * `ctx.fetchApi`. Every call runs as the signed-in user through the normal
 * routes, so route-level permission checks (tenant membership, admin role)
 * apply unchanged. The MCP layer adds no authorisation of its own.
 */
import type { McpRequestContext, McpToolResult } from "@framework/types";

export const API_BASE_PATH = "/api/v1";

/** Success result. Arrays are wrapped in `{ items }` (MCP requires an object). */
export function ok(data: unknown): McpToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const structured =
    data && typeof data === "object"
      ? Array.isArray(data)
        ? { items: data }
        : (data as Record<string, unknown>)
      : undefined;
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

export function fail(message: string): McpToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The organisation the call is for. OAuth tokens carry the organisation the
 * user picked at sign-in, API tokens the one they were minted for. A tool may
 * pass an explicit `tenantId` to work in another organisation the user
 * belongs to (the routes check membership).
 */
export function resolveTenantId(ctx: McpRequestContext, explicit?: string): string {
  if (explicit) return explicit;
  if (ctx.tenantId) return ctx.tenantId;
  throw new Error(
    "No organisation bound to this credential. Pass tenantId (see whoami for your organisations) " +
      "or reconnect and choose an organisation at sign-in.",
  );
}

export const tenantPath = (ctx: McpRequestContext, suffix: string, tenantId?: string) =>
  `${API_BASE_PATH}/tenant/${resolveTenantId(ctx, tenantId)}${suffix}`;

type CallOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  json?: unknown;
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  transform?: (data: unknown) => unknown;
};

const withQuery = (path: string, query: CallOptions["query"]) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

/** Run an API call and turn the response into a tool result (errors become readable error results). */
export async function callApi(ctx: McpRequestContext, path: string, opts: CallOptions = {}): Promise<McpToolResult> {
  const headers: Record<string, string> = {};
  let body: string | FormData | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form;
  }
  let res: Response;
  try {
    res = await ctx.fetchApi(withQuery(path, opts.query), { method: opts.method ?? "GET", headers, body });
  } catch (err) {
    return fail(`API call failed: ${(err as Error).message}`);
  }
  const raw = await res.text();
  let parsed: unknown = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* non-JSON stays text */
  }
  if (!res.ok) {
    const detail = parsed && typeof parsed === "object" ? ((parsed as any).error ?? (parsed as any).message ?? raw) : raw;
    return fail(`API ${res.status}: ${detail}`);
  }
  return ok(opts.transform ? opts.transform(parsed) : parsed);
}

/** Behaviour hints: the gym is a closed domain, reading never changes anything. */
export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
export const writes = (o: { destructive: boolean; idempotent: boolean }) => ({
  readOnlyHint: false,
  destructiveHint: o.destructive,
  idempotentHint: o.idempotent,
  openWorldHint: false,
});
