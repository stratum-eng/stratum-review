import type { AppBindings } from "../env";
import type { JobStore } from "@codraoss/core/ports";
import { makeJobStore as makeDbJobStore } from "@codraoss/db/repositories";
import type { DbEnv } from "@codraoss/db/env";

export function makeJobStore(env: AppBindings): JobStore {
  const dbEnv: DbEnv = {
    DB: env.DB,
    BLOBS: env.BLOBS,
    APP_KV: env.APP_KV,
  };
  return makeDbJobStore(dbEnv);
}
