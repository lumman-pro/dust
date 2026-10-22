/*
Statement 0
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."sandbox_function_invocations" ADD COLUMN "agentConfigurationId" character varying(255) COLLATE "pg_catalog"."default";

/*
Statement 1
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."sandbox_function_invocations" ADD COLUMN "agentMessageId" character varying(255) COLLATE "pg_catalog"."default";

/*
Statement 2
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."sandbox_function_invocations" ADD COLUMN "conversationId" character varying(255) COLLATE "pg_catalog"."default";

/*
Statement 3
  - INDEX_BUILD: This might affect database performance. Concurrent index builds require a non-trivial amount of CPU, potentially affecting database performance. They also can take a while but do not lock out writes.
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY sandbox_function_invocations_workspace_id_conversation_id ON public.sandbox_function_invocations USING btree ("workspaceId", "conversationId") WHERE ("conversationId" IS NOT NULL);
