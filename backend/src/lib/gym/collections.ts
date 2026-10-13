/**
 * Collections: customer projects or use cases. A collection groups skills.
 */
import { and, asc, count, eq } from "drizzle-orm";
import * as v from "valibot";
import { getDb } from "@framework/lib/db/db-connection";
import { COLLECTION_STATUSES, collections, skills, type CollectionSelect } from "../../db/schema";
import { InvalidInputError, NotFoundError } from "./errors";

export const collectionInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "Name is required"), v.maxLength(200)),
  customer: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)), ""),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000)), ""),
  status: v.optional(v.picklist(COLLECTION_STATUSES), "active"),
});

export interface CollectionView extends CollectionSelect {
  skillCount: number;
}

export async function listCollections(tenantId: string): Promise<CollectionView[]> {
  const rows = await getDb()
    .select({ collection: collections, skillCount: count(skills.id) })
    .from(collections)
    .leftJoin(skills, eq(skills.collectionId, collections.id))
    .where(eq(collections.tenantId, tenantId))
    .groupBy(collections.id)
    .orderBy(asc(collections.name));
  return rows.map((r) => ({ ...r.collection, skillCount: Number(r.skillCount) }));
}

export async function getCollection(tenantId: string, id: string): Promise<CollectionSelect> {
  const rows = await getDb()
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), eq(collections.tenantId, tenantId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError("Collection");
  return rows[0];
}

export async function createCollection(tenantId: string, userId: string | null, input: unknown): Promise<CollectionSelect> {
  const data = v.parse(collectionInputSchema, input);
  const existing = await getDb()
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.tenantId, tenantId), eq(collections.name, data.name)))
    .limit(1);
  if (existing[0]) throw new InvalidInputError(`A collection named "${data.name}" already exists`);
  const [row] = await getDb()
    .insert(collections)
    .values({ tenantId, createdBy: userId, ...data })
    .returning();
  return row!;
}

export async function updateCollection(tenantId: string, id: string, input: unknown): Promise<CollectionSelect> {
  const data = v.parse(v.partial(collectionInputSchema), input);
  const [row] = await getDb()
    .update(collections)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(collections.id, id), eq(collections.tenantId, tenantId)))
    .returning();
  if (!row) throw new NotFoundError("Collection");
  return row;
}

/** Skills of a deleted collection stay and lose their grouping. */
export async function deleteCollection(tenantId: string, id: string): Promise<void> {
  const deleted = await getDb()
    .delete(collections)
    .where(and(eq(collections.id, id), eq(collections.tenantId, tenantId)))
    .returning({ id: collections.id });
  if (!deleted.length) throw new NotFoundError("Collection");
}
