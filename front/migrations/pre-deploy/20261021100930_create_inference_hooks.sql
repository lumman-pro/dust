/*
Statement 0
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
CREATE SEQUENCE "public"."inference_hook_versions_id_seq"
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
CREATE SEQUENCE "public"."inference_hooks_id_seq"
	AS bigint
	INCREMENT BY 1
	MINVALUE 1 MAXVALUE 9223372036854775807
	START WITH 1 CACHE 1 NO CYCLE
;

/*
Statement 2
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
CREATE TABLE "public"."inference_hook_versions" (
	"workspaceId" bigint NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"authorId" bigint NOT NULL,
	"hookId" bigint NOT NULL,
	"id" bigint DEFAULT nextval('inference_hook_versions_id_seq'::regclass) NOT NULL,
	"version" integer NOT NULL,
	"timeoutMs" integer NOT NULL,
	"events" character varying(255)[] COLLATE "pg_catalog"."default" NOT NULL,
	"providerConfig" jsonb NOT NULL,
	"credentialId" character varying(255) COLLATE "pg_catalog"."default",
	"excludedGroupIds" bigint[] DEFAULT ARRAY[]::bigint[] NOT NULL,
	"onError" character varying(255) COLLATE "pg_catalog"."default" NOT NULL,
	"enforcement" character varying(255) COLLATE "pg_catalog"."default"
);

/*
Statement 3
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hook_versions_pkey ON public.inference_hook_versions USING btree (id);

/*
Statement 4
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_versions" ADD CONSTRAINT "inference_hook_versions_pkey" PRIMARY KEY USING INDEX "inference_hook_versions_pkey";

/*
Statement 5
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hook_versions_author_id ON public.inference_hook_versions USING btree ("authorId");

/*
Statement 6
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hook_versions_hook_id_version ON public.inference_hook_versions USING btree ("hookId", version);

/*
Statement 7
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hook_versions_workspace_id ON public.inference_hook_versions USING btree ("workspaceId");

/*
Statement 8
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER SEQUENCE "public"."inference_hook_versions_id_seq" OWNED BY "public"."inference_hook_versions"."id";

/*
Statement 9
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
CREATE TABLE "public"."inference_hooks" (
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"archivedAt" timestamp with time zone,
	"workspaceId" bigint NOT NULL,
	"id" bigint DEFAULT nextval('inference_hooks_id_seq'::regclass) NOT NULL,
	"createdByUserId" bigint NOT NULL,
	"currentVersion" integer NOT NULL,
	"provider" character varying(255) COLLATE "pg_catalog"."default" NOT NULL,
	"name" character varying(255) COLLATE "pg_catalog"."default" NOT NULL
);

/*
Statement 10
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE UNIQUE INDEX CONCURRENTLY inference_hooks_pkey ON public.inference_hooks USING btree (id);

/*
Statement 11
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hooks" ADD CONSTRAINT "inference_hooks_pkey" PRIMARY KEY USING INDEX "inference_hooks_pkey";

/*
Statement 12
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hooks_created_by_user_id ON public.inference_hooks USING btree ("createdByUserId");

/*
Statement 13
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY inference_hooks_workspace_id ON public.inference_hooks USING btree ("workspaceId");

/*
Statement 14
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_versions" ADD CONSTRAINT "inference_hook_versions_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES inference_hooks(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 15
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_versions" VALIDATE CONSTRAINT "inference_hook_versions_hookId_fkey";

/*
Statement 16
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER SEQUENCE "public"."inference_hooks_id_seq" OWNED BY "public"."inference_hooks"."id";

/*
Statement 17
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_versions" ADD CONSTRAINT "inference_hook_versions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 18
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_versions" VALIDATE CONSTRAINT "inference_hook_versions_authorId_fkey";

/*
Statement 19
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hooks" ADD CONSTRAINT "inference_hooks_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 20
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hooks" VALIDATE CONSTRAINT "inference_hooks_createdByUserId_fkey";

/*
Statement 21
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_versions" ADD CONSTRAINT "inference_hook_versions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 22
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hook_versions" VALIDATE CONSTRAINT "inference_hook_versions_workspaceId_fkey";

/*
Statement 23
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hooks" ADD CONSTRAINT "inference_hooks_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

/*
Statement 24
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."inference_hooks" VALIDATE CONSTRAINT "inference_hooks_workspaceId_fkey";
