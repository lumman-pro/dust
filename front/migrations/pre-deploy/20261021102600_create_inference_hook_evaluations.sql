/*
Statement 0
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
CREATE SEQUENCE "public"."inference_hook_evaluations_id_seq"
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
CREATE TABLE "public"."inference_hook_evaluations" (
	"workspaceId" bigint NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"hookVersionId" bigint NOT NULL,
	"requestedAt" timestamp with time zone NOT NULL,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"checkpointId" bigint NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"id" bigint DEFAULT nextval('inference_hook_evaluations_id_seq'::regclass) NOT NULL,
	"index" integer NOT NULL,
	"reason" text COLLATE "pg_catalog"."default",
	"errorMessage" text COLLATE "pg_catalog"."default",
	"tags" character varying(255)[] COLLATE "pg_catalog"."default" DEFAULT (ARRAY[]::character varying[])::character varying(255)[] NOT NULL,
	"providerReference" character varying(255) COLLATE "pg_catalog"."default",
	"errorCode" character varying(255) COLLATE "pg_catalog"."default",
	"outcome" character varying(255) COLLATE "pg_catalog"."default",
	"verdict" character varying(255) COLLATE "pg_catalog"."default",
	"status" character varying(255) COLLATE "pg_catalog"."default" NOT NULL
);

/*
Statement 2
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_evaluations" ADD CONSTRAINT "inference_hook_evaluations_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES inference_hook_checkpoints(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 3
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_evaluations" VALIDATE CONSTRAINT "inference_hook_evaluations_checkpointId_fkey";

/*
Statement 4
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hook_evaluations_pkey ON public.inference_hook_evaluations USING btree (id);

/*
Statement 5
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_evaluations" ADD CONSTRAINT "inference_hook_evaluations_pkey" PRIMARY KEY USING INDEX "inference_hook_evaluations_pkey";

/*
Statement 6
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hook_evaluations_checkpoint_id_hook_version_id_index ON public.inference_hook_evaluations USING btree ("checkpointId", "hookVersionId", index);

/*
Statement 7
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hook_evaluations_hook_version_id_created_at ON public.inference_hook_evaluations USING btree ("hookVersionId", "createdAt");

/*
Statement 8
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hook_evaluations_workspace_id_created_at ON public.inference_hook_evaluations USING btree ("workspaceId", "createdAt");

/*
Statement 9
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER SEQUENCE "public"."inference_hook_evaluations_id_seq" OWNED BY "public"."inference_hook_evaluations"."id";

/*
Statement 10
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_evaluations" ADD CONSTRAINT "inference_hook_evaluations_hookVersionId_fkey" FOREIGN KEY ("hookVersionId") REFERENCES inference_hook_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 11
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_evaluations" VALIDATE CONSTRAINT "inference_hook_evaluations_hookVersionId_fkey";

/*
Statement 12
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_evaluations" ADD CONSTRAINT "inference_hook_evaluations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 13
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_evaluations" VALIDATE CONSTRAINT "inference_hook_evaluations_workspaceId_fkey";
