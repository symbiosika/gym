/**
 * Helpers shared by the gym route files: parameter schemas, the mapping of
 * business-logic errors onto HTTP status codes and the acting user.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import log from "@framework/lib/log";
import { actorFromUser, type Actor } from "../../../../lib/gym/audit";
import { CriticsError } from "../../../../lib/critics/client";
import { ConflictError, InvalidInputError, NotFoundError, TokenError, UpstreamError } from "../../../../lib/gym/errors";

export const tenantParam = v.object({ tenantId: v.pipe(v.string(), v.uuid()) });
export const tenantIdParam = v.object({
  tenantId: v.pipe(v.string(), v.uuid()),
  id: v.pipe(v.string(), v.uuid()),
});
export const langQuery = v.object({ lang: v.optional(v.picklist(["de", "en"]), "de") });

export const ok = { 200: { description: "Successful response" } };

/** The signed-in user as an audit actor. */
export const actorOf = (c: Context): Promise<Actor> => actorFromUser(c.get("usersId") as string);

export function toHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof v.ValiError) {
    const issues = (error.issues as { path?: { key: unknown }[]; message: string }[])
      .map((i) => `${i.path?.map((p) => String(p.key)).join(".") ?? ""} ${i.message}`.trim())
      .join("; ");
    return new HTTPException(400, { message: `Validation error: ${issues}` });
  }
  if (error instanceof NotFoundError) return new HTTPException(404, { message: error.message });
  if (error instanceof ConflictError) return new HTTPException(409, { message: error.message });
  if (error instanceof InvalidInputError) return new HTTPException(400, { message: error.message });
  if (error instanceof TokenError) return new HTTPException(410, { message: error.message });
  if (error instanceof UpstreamError) return new HTTPException(502, { message: error.message });
  // 503 is the client's own "service unreachable". What the critics answered
  // themselves is relayed: their 4xx is about the request GYM sent on the
  // operator's behalf (an episode that is not there, datasets that do not fit
  // together), and reading that as a bad gateway would hide the one sentence
  // the operator can act on. Only their 5xx is a gateway failure.
  if (error instanceof CriticsError) {
    const status = error.status === 503 ? 503 : error.status >= 400 && error.status < 500 ? error.status : 502;
    return new HTTPException(status as 400, { message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error(`Unhandled gym route error: ${message}`);
  return new HTTPException(500, { message: "Internal server error" });
}

