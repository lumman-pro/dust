/*
Statement 0
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
CREATE SEQUENCE "public"."inference_hook_checkpoints_id_seq"
	AS bigint
	INCREMENT BY 1
	MINVALUE 1 MAXVALUE 9223372036854775807
	START WITH 1 CACHE 1 NO CYCLE
;

/*
Statement 1
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
CREATE TABLE "public"."inference_hook_checkpoints" (
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"decidedAt" timestamp with time zone,
	"workspaceId" bigint NOT NULL,
	"id" bigint DEFAULT nextval('inference_hook_checkpoints_id_seq'::regclass) NOT NULL,
	"conversationId" bigint NOT NULL,
	"agentMessageId" bigint NOT NULL,
	"userId" bigint,
	"step" integer NOT NULL,
	"event" character varying(255) COLLATE "pg_catalog"."default" NOT NULL,
	"dustRunId" character varying(255) COLLATE "pg_catalog"."default",
	"decision" character varying(255) COLLATE "pg_catalog"."default" NOT NULL
);

/*
Statement 2
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" ADD CONSTRAINT "inference_hook_checkpoints_agentMessageId_fkey" FOREIGN KEY ("agentMessageId") REFERENCES agent_messages(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 3
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" VALIDATE CONSTRAINT "inference_hook_checkpoints_agentMessageId_fkey";

/*
Statement 4
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hook_checkpoints_pkey ON public.inference_hook_checkpoints USING btree (id);

/*
Statement 5
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" ADD CONSTRAINT "inference_hook_checkpoints_pkey" PRIMARY KEY USING INDEX "inference_hook_checkpoints_pkey";

/*
Statement 6
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hook_checkpoints_agent_message_step_event_no_run ON public.inference_hook_checkpoints USING btree ("agentMessageId", step, event) WHERE ("dustRunId" IS NULL);

/*
Statement 7
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hook_checkpoints_agent_message_step_event_run ON public.inference_hook_checkpoints USING btree ("agentMessageId", step, event, "dustRunId");

/*
Statement 8
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hook_checkpoints_conversation_id ON public.inference_hook_checkpoints USING btree ("conversationId");

/*
Statement 9
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hook_checkpoints_user_id ON public.inference_hook_checkpoints USING btree ("userId");

/*
Statement 10
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hook_checkpoints_workspace_id ON public.inference_hook_checkpoints USING btree ("workspaceId");

/*
Statement 11
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER SEQUENCE "public"."inference_hook_checkpoints_id_seq" OWNED BY "public"."inference_hook_checkpoints"."id";

/*
Statement 12
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" ADD CONSTRAINT "inference_hook_checkpoints_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES conversations(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 13
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" VALIDATE CONSTRAINT "inference_hook_checkpoints_conversationId_fkey";

/*
Statement 14
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" ADD CONSTRAINT "inference_hook_checkpoints_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 15
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" VALIDATE CONSTRAINT "inference_hook_checkpoints_userId_fkey";

/*
Statement 16
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" ADD CONSTRAINT "inference_hook_checkpoints_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 17
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_checkpoints" VALIDATE CONSTRAINT "inference_hook_checkpoints_workspaceId_fkey";
