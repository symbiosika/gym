import { defineServer } from "@framework/index";
import * as appDbSchema from "./db/schema";
import defineAppInfoRoutes from "./routes/public/app-info";
import defineMobileRoutes from "./routes/public/mobile";
import defineGymRoutes from "./routes/tenant/[tenantId]/gym";
import { deactivateExpiredCodes } from "./lib/gym/invitation-codes";
import { joinOrganisationFromInvitationCode } from "./lib/gym/registration";
import { gymMcpServer, SCOPES_SUPPORTED } from "./mcp";
import { syncAllOpenDatasets } from "./lib/critics/sync";
import { cleanupStaleUploads } from "./lib/gym/dataset-uploads";
import { assertStorageConfigured } from "./lib/storage";
import log from "@framework/lib/log";

/**
 * GYM: the daily work of a robotics gym (see docs/PRODUCT.md).
 *
 * The framework (backend/framework, git submodule) provides users,
 * organisations (tenants), magic-link login, file storage, the OAuth2 server
 * for MCP clients and the database layer. This app adds the gym tables
 * (src/db/schema.ts), the operator API (src/routes), the public routes of the
 * mobile and print views and the analyst's MCP server (src/mcp). Dataset
 * analysis is done by the data critics, the Python service in `critics/` of
 * this repository that runs next to the app in the same compose stack
 * (CRITICS_URL, src/lib/critics).
 *
 * Every byte the app stores (scene photos, the reference images of a plan, the
 * chunks of a dataset upload) goes through src/lib/storage, which puts it
 * where GYM_STORAGE_DRIVER says: the database or an S3-compatible object
 * store. A configuration that cannot work is refused here and not on the first
 * upload of the day.
 */
log.info(`gym: storage driver "${assertStorageConfigured()}"`);

const server = defineServer({
  port: Number(process.env.PORT ?? 3000),
  jwtExpiresAfter: 60 * 60 * 24 * 30, // 30 days
  magicLinkTtl: 60 * 60 * 24, // 24 hours
  appName: process.env.APP_NAME ?? "GYM",
  basePath: "/api/v1",
  loginUrl: "/login.html",
  magicLoginVerifyUrl: "/magic-login-verify.html",
  staticPublicDataPath: "./public",
  staticPrivateDataPath: "./static",
  // The SPA bundle under /static/app is served without the login redirect: the
  // mobile and print views run on devices where nobody is signed in, and every
  // authenticated API call the bundle makes is checked on its own.
  staticPrivateExclude: ["app"],
  oauth2: {
    enabled: true,
    introspectionSecret: process.env.OAUTH_INTROSPECTION_SECRET,
    emailLoginCodeTtl: 60 * 60,
    dcrDefaultScopes: SCOPES_SUPPORTED,
  },
  mcpServers: [gymMcpServer],
  customDbSchema: { ...appDbSchema },
  // A sign-up with an organisation's invitation code lands in that organisation.
  customPostRegisterActions: [
    async (userId, email, meta) => {
      await joinOrganisationFromInvitationCode(userId, email, meta);
    },
  ],
  customHonoApps: [
    {
      baseRoute: "",
      app: (app) => {
        defineAppInfoRoutes(app);
        defineMobileRoutes(app);
      },
    },
  ],
  customHonoAppsWithAuth: [
    {
      baseRoute: "",
      app: (app) => {
        defineGymRoutes(app);
      },
    },
  ],
  customCronJobs: [
    {
      name: "gym-expire-invitation-codes",
      schedule: "* * * * *",
      handler: async () => {
        await deactivateExpiredCodes();
      },
    },
    // critics runs finish on their own schedule; mirror them even when nobody is looking
    {
      name: "gym-sync-critics-jobs",
      schedule: "* * * * *",
      handler: async () => {
        await syncAllOpenDatasets();
      },
    },
    // chunks of dataset uploads that were never completed (a closed browser, an
    // operator who went home) would otherwise fill the storage
    {
      name: "gym-cleanup-dataset-uploads",
      schedule: "*/15 * * * *",
      handler: async () => {
        await cleanupStaleUploads();
      },
    },
  ],
});

export default server;
