import type { AppBindings } from "../env";
import type { FileReviewStore } from "@codraoss/core/ports";
import { makeFileReviewStore as makeDbFileReviewStore } from "@codraoss/db/repositories";
import type { DbEnv } from "@codraoss/db/env";

export function makeFileReviewStore(env: AppBindings): FileReviewStore {
  const dbEnv: DbEnv = {
    DB: env.DB,
    BLOBS: env.BLOBS,
    APP_KV: env.APP_KV,
  };
  return makeDbFileReviewStore(dbEnv);
}
