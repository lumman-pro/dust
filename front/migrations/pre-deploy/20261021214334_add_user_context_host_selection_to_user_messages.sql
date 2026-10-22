/*
Statement 0
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."user_messages" ADD COLUMN "userContextHostSelection" character varying(256);
