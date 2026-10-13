/**
 * Demo data for a local environment.
 *
 *   bun run seed:demo                # first organisation in the database
 *   TENANT_ID=<uuid> bun run seed:demo
 *
 * Creates two cells, a collection, a skill and one recording block in the
 * "plan" step on today's day protocol, so the wizard has something to show.
 * Idempotent for the cells, the collection and the skill (matched by name); a
 * new block is only started when the skill has no block today. Uses the same
 * business logic as the API. Needs the backend .env (Bun loads it) and a
 * running database.
 */
import { getDb } from "@framework/lib/db/db-connection";
import { tenants } from "@framework/lib/db/schema/users";
import { generatePlan, listBlocks, startBlock, updateBrief } from "../src/lib/gym/blocks";
import { createCell, listCells } from "../src/lib/gym/cells";
import { createCollection, listCollections } from "../src/lib/gym/collections";
import { createSkill, listSkills } from "../src/lib/gym/skills";
import { isoDate } from "../src/lib/gym/time";

const tenantId =
  process.env.TENANT_ID ?? (await getDb().select({ id: tenants.id }).from(tenants).limit(1))[0]?.id;
if (!tenantId) {
  console.error("no organisation found; sign in once (bun run testuser) or set TENANT_ID");
  process.exit(1);
}

const actor = { userId: null, userName: "demo seed" };
const existingCells = await listCells(tenantId);
for (const c of [
  { name: "Cell 13", location: "Riederich", robot: "MAiRA" },
  { name: "Cell 14", location: "Riederich", robot: "MAiRA" },
]) {
  if (!existingCells.some((x) => x.name === c.name)) await createCell(tenantId, c);
}
const cells = await listCells(tenantId);

const COLLECTION = "Demo pilot";
let collection = (await listCollections(tenantId)).find((c) => c.name === COLLECTION);
if (!collection) {
  collection = { ...(await createCollection(tenantId, null, { name: COLLECTION, customer: "Example Robotics", description: "Household manipulation skills." })), skillCount: 0 };
}

const SKILL = "Cup to tray";
let skill = (await listSkills(tenantId)).find((s) => s.name === SKILL);
if (!skill) {
  await createSkill(tenantId, actor, {
    name: SKILL,
    collectionId: collection.id,
    taskDescription: "Pick the cup from the table and place it on the tray.",
  });
  skill = (await listSkills(tenantId)).find((s) => s.name === SKILL)!;
}

const today = isoDate(new Date());
const todays = (await listBlocks(tenantId, { skillId: skill.id })).filter((b) => b.date === today);
if (todays.length) {
  console.log("the demo skill already has a block today, nothing to do");
} else {
  const { day, block } = await startBlock(tenantId, actor, { cellId: cells[0]!.id, skillId: skill.id, kind: "recording" });
  await updateBrief(tenantId, actor, block.id, {
    sceneText: "Cup on the left half of the table, tray on the right, two distractor objects.",
    targetEpisodes: 120,
  });
  await generatePlan(tenantId, actor, block.id, "de");
  console.log(`demo skill ${skill.id}, day protocol ${day.id}, block ${block.id} (${today})`);
}
process.exit(0);
