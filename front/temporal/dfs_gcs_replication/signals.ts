import { defineSignal } from "@temporalio/workflow";

export const reconcileGcsSourceSignal = defineSignal<[]>(
  "reconcile_gcs_source"
);
