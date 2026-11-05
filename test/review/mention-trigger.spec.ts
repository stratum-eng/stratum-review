import { createApiRouter } from "@codraoss/api";
import { resolveQueuedJob } from "../../packages/core/src/review/resolve-job";
import { createReviewRuntime } from "@server/adapters";
import { createTestEnv, uniqueName } from "../helpers";
import { signPayload } from "../mocks/fixtures";

function commentWebhook(body: string, repo: string, isPullRequest = true) {
  return {
    action: "created",
    installation: { id: 12345 },
    repository: { name: repo, owner: { login: "test-owner" } },
    issue: {
      number: 7,
      ...(isPullRequest ? { pull_request: { url: "https://example.test" } } : {}),
    },
    comment: { id: 1, body, user: { login: "someone" } },
  };
}

describe("@mention review requests", () => {
  const env = createTestEnv();
  const app = createApiRouter();
  const queue = env.REVIEW_QUEUE as any;

  beforeEach(() => {
    queue.sent.length = 0;
  });

  async function deliver(payload: unknown) {
    const body = JSON.stringify(payload);
    return app.request(
      "http://codra.test/webhook",
      {
        method: "POST",
        headers: {
          "x-github-event": "issue_comment",
          "x-github-delivery": uniqueName("mention"),
          "x-hub-signature-256": await signPayload(
            env.GITHUB_APP_WEBHOOK_SECRET,
            body,
          ),
          "content-type": "application/json",
        },
        body,
      },
      env,
    );
  }

  it("creates a job for the pull request's head when a comment tags the bot", async () => {
    const repo = uniqueName("mention-repo");
    const response = await deliver(
      commentWebhook("@stratum-review review", repo),
    );
    expect(response.status).toBe(202);
    expect(queue.sent).toHaveLength(1);

    const runtime = createReviewRuntime(env as any);
    runtime.githubClients = {
      forInstallation: () => ({
        getPullRequest: async () => ({
          title: "A change",
          user: { login: "author" },
          head: { sha: "a".repeat(40), ref: "feature" },
          base: { sha: "b".repeat(40), ref: "main" },
        }),
      }),
    } as any;

    const resolved = await resolveQueuedJob(runtime, queue.sent[0]);

    expect(resolved?.phase).toBe("prepare");
    expect(resolved?.job).toMatchObject({
      prNumber: 7,
      commitSha: "a".repeat(40),
      trigger: "mention",
    });
  });

  it("does not start any work for a comment that doesn't tag the bot", async () => {
    const response = await deliver(
      commentWebhook("looks good to me", uniqueName("mention-repo")),
    );
    const json = (await response.json()) as any;

    expect(response.status).toBe(202);
    expect(json.ignored).toBe(true);
    expect(queue.sent).toHaveLength(0);
  });

  it("does not start any work for a mention on a plain issue", async () => {
    await deliver(
      commentWebhook("@stratum-review", uniqueName("mention-repo"), false),
    );
    expect(queue.sent).toHaveLength(0);
  });
});
