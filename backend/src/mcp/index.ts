/**
 * The GYM MCP server, embedded in the backend: the analyst's door, for a
 * person's assistant or an autonomous agent.
 *
 * `defineServer({ mcpServers: [gymMcpServer] })` mounts it at `/mcp` on the
 * domain root. The framework handles authentication (OAuth2 access tokens
 * from the built-in authorization server, API tokens, session JWTs), the
 * RFC 9728 discovery document and CORS. Tool handlers call this app's own
 * HTTP API in process as the authenticated user.
 *
 * Connect from claude.ai (custom connector): https://<host>/mcp
 * Connect from a script: X-API-KEY with a token from the profile.
 */
import type { McpServerDefinition } from "@framework/types";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { gymTools } from "./tools";

/**
 * Scopes advertised to OAuth clients. Must be covered by `oauth2.dcrDefaultScopes`
 * in src/index.ts, otherwise dynamically registered clients fail at authorize.
 */
export const SCOPES_SUPPORTED = ["openid", "profile", "email", "user:read", "tenants:read"];

export const gymMcpServer: McpServerDefinition = {
  path: "/mcp",
  name: "gym-mcp",
  title: "GYM",
  version: "1.0.0",
  instructions: SERVER_INSTRUCTIONS,
  scopesSupported: SCOPES_SUPPORTED,
  tools: gymTools,
  resources: [
    {
      uri: "gym://glossary",
      name: "glossary",
      title: "Gym glossary",
      description: "The binding vocabulary of the gym, from docs/GLOSSARY.md.",
      mimeType: "text/markdown",
      read: async () => ({
        mimeType: "text/markdown",
        text: [
          "# Glossary",
          "",
          "| Term | Meaning |",
          "|---|---|",
          "| Cell | A physical training cell in the gym. |",
          "| Day protocol | One per cell and day; the controlling record: operator, downtime, notes, blocks. |",
          "| Block | One stretch of work in a day protocol for one skill: a recording block or an evaluation block. |",
          "| Collection | A customer project or use case; groups skills. |",
          "| Skill | What is trained: task, spec, recording blocks, selection, exports, policies. |",
          "| Policy | A trained version of a skill; evaluation blocks test one. |",
          "| Recording | One teleoperation run of a block that produces a dataset. |",
          "| Evaluation | A block in which a policy runs; its rollouts are datasets judged by the critics. |",
          "| Dataset | One uploaded LeRobot export; has exactly one analysis. |",
          "| Episode | One execution of a task inside a dataset; in an evaluation one rollout. |",
          "| Export | A saved episode selection of a skill, recording datasets only. |",
        ].join("\n"),
      }),
    },
  ],
};
