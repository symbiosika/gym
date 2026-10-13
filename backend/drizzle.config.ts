import { defineConfig } from "drizzle-kit";
import { PREFIX } from "./src/db";

const POSTGRES_DB = process.env.POSTGRES_DB ?? "";
const POSTGRES_USER = process.env.POSTGRES_USER ?? "";
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "";
const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "";
const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432");
const POSTGRES_CA = process.env.POSTGRES_CA ?? "";
const POSTGRES_USE_SSL =
  POSTGRES_CA.length > 0 && POSTGRES_CA !== "none";

console.log("RUNNING MIGRATIONS FOR APP (gym)");
console.log(
  "Connect to database: ",
  `postgresql://${POSTGRES_USER}:***@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle-sql",
  tablesFilter: PREFIX + "*",
  migrations: {
    table: `${PREFIX}migrations`,
  },
  dbCredentials: {
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    database: POSTGRES_DB,
    ...(POSTGRES_USE_SSL
      ? { ssl: { rejectUnauthorized: false, ca: POSTGRES_CA } }
      : { ssl: false }),
  },
});
