import type { SymbiosikaFrameworkHonoApp } from "@framework/types";
import defineMasterDataRoutes from "./master-data";
import defineSkillRoutes from "./skills";
import defineDayProtocolRoutes from "./day-protocols";
import defineBlockRoutes from "./blocks";
import defineKpiRoutes from "./kpis";
import defineInvitationCodeRoutes from "./invitation-codes";
import defineCriticsRoutes from "./critics";
import defineEvaluationRoutes from "./evaluations";

/** All authenticated gym routes under /tenant/:tenantId/gym/… */
export default function defineGymRoutes(app: SymbiosikaFrameworkHonoApp, API_BASE_PATH = "") {
  defineMasterDataRoutes(app, API_BASE_PATH);
  defineSkillRoutes(app, API_BASE_PATH);
  defineDayProtocolRoutes(app, API_BASE_PATH);
  defineBlockRoutes(app, API_BASE_PATH);
  defineKpiRoutes(app, API_BASE_PATH);
  defineInvitationCodeRoutes(app, API_BASE_PATH);
  defineCriticsRoutes(app, API_BASE_PATH);
  defineEvaluationRoutes(app, API_BASE_PATH);
}
