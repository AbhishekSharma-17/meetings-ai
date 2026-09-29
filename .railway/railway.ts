// Railway settings for the Meetings AI web and API services (Infrastructure as Code).
//
// Scope: only these two services' deploy settings. Vexa and the databases are deliberately not
// declared, so this file never manages or changes them. Variables are listed as preserve():
// the values stay in Railway and are never written here. Builds keep using each service's
// Dockerfile through the RAILWAY_DOCKERFILE_PATH variable.
//
// Health checks make every release zero-downtime: a release only takes traffic once it answers
// (/ready also requires the database at the current schema version), and a release that never
// becomes healthy fails while the previous one keeps serving. The web keeps the old release for
// 15 s after the switch; the API uses no overlap and a short drain. Background loops only run in
// the leader-elected API process (services/api/app/leader.py; see docs/deployment/railway.md).
//
// Keep `export const partial` below. Without it Railway treats this file as the whole project,
// and `railway config apply` would DELETE the Vexa service and both databases.
//
// Check for drift (read-only):  npm install --no-save railway@3  then  railway config plan
//   (expects "already up to date"; run `railway` directly, not through `timeout`/`npx`,
//   because the SDK checks the CLI version via the invoking program)
// Change a setting: edit here, run railway config plan, review it, then railway config apply
import { defineRailway, preserve, project, service } from "railway/iac";

// Named partial: this file owns only the resources it declares (the web and API services).
export const partial = "app-services";

export default defineRailway(() => {
  const meetingsAiWeb = service("meetings-ai-web", {
    healthcheck: "/",
    healthcheckTimeout: 300,
    replicas: { "us-west2": 1 },
    deploy: { drainingSeconds: 30, overlapSeconds: 15 },
    domains: ["meeting.genaiprotos.com"],
    env: { API_INTERNAL_BASE_URL: preserve(), PORT: preserve(), RAILWAY_DOCKERFILE_PATH: preserve() },
  });
  const meetingsAiApi = service("meetings-ai-api", {
    healthcheck: "/ready",
    healthcheckTimeout: 300,
    replicas: { "us-west2": 1 },
    deploy: { drainingSeconds: 10, overlapSeconds: 0 },
    env: { APP_BASE_URL: preserve(), APP_ENV: preserve(), AUTO_CALENDAR_SCHEDULE_ENABLED: preserve(), AUTO_KNOWLEDGE_INDEX_ENABLED: preserve(), AUTO_MOM_ENABLED: preserve(), AUTO_RETENTION_ENABLED: preserve(), COMPOSIO_API_KEY: preserve(), COMPOSIO_CALENDLY_AUTH_CONFIG_ID: preserve(), COMPOSIO_CALENDLY_VERSION: preserve(), COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID: preserve(), COMPOSIO_GOOGLE_CALENDAR_VERSION: preserve(), COMPOSIO_OUTLOOK_AUTH_CONFIG_ID: preserve(), COMPOSIO_OUTLOOK_VERSION: preserve(), COMPOSIO_ZOOM_AUTH_CONFIG_ID: preserve(), COMPOSIO_ZOOM_VERSION: preserve(), DATABASE_URL: preserve(), MEETINGS_AI_ADMIN_EMAIL: preserve(), MEETINGS_AI_ADMIN_PASSWORD: preserve(), MEETINGS_AI_SESSION_SECRET: preserve(), PORT: preserve(), PROVIDER_CREDENTIAL_KEY: preserve(), RAILWAY_DOCKERFILE_PATH: preserve(), RESEND_API_KEY: preserve(), RESEND_FROM_EMAIL: preserve(), RESEND_FROM_NAME: preserve(), VEXA_API_KEY: preserve(), VEXA_BASE_URL: preserve(), VEXA_STT_OVERRIDE_SECRET: preserve(), WEB_ORIGIN: preserve() },
  });

  return project("Meetings Ai", {
    resources: [meetingsAiWeb, meetingsAiApi],
  });
});
