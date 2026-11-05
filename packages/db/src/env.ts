export type D1BoundStatement = {
  all<T>(): Promise<{ results: T[] }>;
};

export type D1PreparedStatement = D1BoundStatement & {
  bind(...values: unknown[]): D1BoundStatement;
};

// Structural, so this package needs no dependency on Workers types and tests can pass Miniflare's binding.
export type D1Binding = {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: never[]): Promise<Array<{ results?: unknown[] }>>;
};

export type BlobBucket = {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};

export type DbEnv = {
  DB: D1Binding;
  BLOBS: BlobBucket;
  APP_KV: {
    put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
  };
};
