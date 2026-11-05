import { beforeEach, describe, expect, it } from "vitest";
import { runReview, type ReviewJobRunResult } from "../src";
import { setLoggerSink } from "../src/logger";
import { createInMemoryRuntime } from "./in-memory";

// Note what is NOT here: no vi.mock, no module interception, no test database, no fetch stub. The

beforeEach(() => {
  setLoggerSink({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  });
});

/** Drives runReview the way a host driver would: one phase per call, following the result. */
async function drive(
  runtime: Parameters<typeof runReview>[0],
  jobId: string,
  maxPhases = 10,
) {
  const results: ReviewJobRunResult[] = [];
  let next: { jobId: string; phase?: "prepare" | "review" | "finalize" } = {
    jobId,
    phase: "prepare",
  };

  for (let i = 0; i < maxPhases; i++) {
    const result = await runReview(runtime, next as never);
    results.push(result);
    if (result.action !== "next_phase") return results;
    next = { jobId: result.jobId ?? jobId, phase: result.phase };
  }
  throw new Error(`Review did not settle within ${maxPhases} phases`);
}

describe("runReview end to end on in-memory ports", () => {
  it("carries a job from prepare through review to a posted review", async () => {
    const { runtime, recorded } = createInMemoryRuntime({
      model: {
        findingsByPath: {
          "src/retry.ts": [
            {
              title: "Hard-coded delay",
              body: "Extract the 1000ms delay into a constant.",
              line: 2,
              evidence: "const delay = 1000;",
            },
          ],
        },
      },
    });
    const jobId = [...recorded.jobs.keys()][0];

    const results = await drive(runtime, jobId);

    expect(results.map((r) => r.action)).toEqual([
      "next_phase",
      "next_phase",
      "ack",
    ]);
    expect(results[0]).toMatchObject({ action: "next_phase", phase: "review" });
    expect(results[1]).toMatchObject({
      action: "next_phase",
      phase: "finalize",
      freshInstance: true,
    });

    const job = recorded.jobs.get(jobId)!;
    expect(job.status).toBe("done");
    expect(job.verdict).toBe("comment");

    expect([...recorded.fileReviews.keys()].sort()).toEqual([
      "src/log.ts",
      "src/retry.ts",
    ]);
    expect(
      [...recorded.fileReviews.values()].every(
        (row) => row.file_status === "done",
      ),
    ).toBe(true);

    expect(recorded.postedReviews).toHaveLength(1);
    expect(recorded.postedReviews[0].comments).toEqual([
      {
        path: "src/retry.ts",
        body: expect.stringContaining("Hard-coded delay"),
      },
    ]);
    // The posted body is the formatter's overview, carrying the head sha and the count actually posted.
    expect(recorded.postedReviews[0].body).toContain(
      `Reviewed ${"a".repeat(7)}: 1 posted`,
    );

    expect(recorded.checkRuns[0].title).toBe("Review queued");
    expect(recorded.checkRuns.at(-1)).toMatchObject({ status: "completed" });
    expect(recorded.telemetry).toHaveLength(1);
  });

  it("claims the lease before doing any work, and releases it on every exit", async () => {
    const { runtime, recorded } = createInMemoryRuntime();
    const jobId = [...recorded.jobs.keys()][0];

    await drive(runtime, jobId);

    expect(recorded.calls[0]).toBe("claimJobLease");
    expect(
      recorded.calls.filter((call) => call === "releaseJobLease"),
    ).toHaveLength(3);
    expect(
      recorded.calls.filter((call) => call === "claimJobLease"),
    ).toHaveLength(3);
  });

  it("approves a clean diff without posting inline comments", async () => {
    const { runtime, recorded } = createInMemoryRuntime();
    const jobId = [...recorded.jobs.keys()][0];

    await drive(runtime, jobId);

    expect(recorded.jobs.get(jobId)!.verdict).toBe("approve");
    expect(recorded.postedReviews[0].comments).toEqual([]);
  });

  it("posts both findings when the verifier keeps them, and one when it refutes the other", async () => {
    const findingsByPath = {
      "src/retry.ts": [
        {
          title: "Hard-coded delay",
          body: "Extract it.",
          line: 2,
          evidence: "const delay = 1000;",
        },
      ],
      "src/log.ts": [
        {
          title: "Logs user input",
          body: "Could leak PII.",
          line: 2,
          evidence: "console.log(message);",
        },
      ],
    };

    const kept = createInMemoryRuntime({ model: { findingsByPath } });
    await drive(kept.runtime, [...kept.recorded.jobs.keys()][0]);
    expect(
      kept.recorded.postedReviews[0].comments.map((c) => c.path).sort(),
    ).toEqual(["src/log.ts", "src/retry.ts"]);
    expect(
      kept.recorded.calls.some((call) => call === "verifyFindings:2"),
    ).toBe(true);

    const refuted = createInMemoryRuntime({
      model: { findingsByPath, verifyVerdicts: { 0: "drop" } },
    });
    await drive(refuted.runtime, [...refuted.recorded.jobs.keys()][0]);
    expect(refuted.recorded.postedReviews[0].comments).toHaveLength(1);
    expect(
      refuted.recorded.calls.some((call) =>
        call.startsWith("markDispositions:"),
      ),
    ).toBe(true);
  });

  it("fetches the diff from the provider once and serves later phases from the cache", async () => {
    const { runtime, recorded } = createInMemoryRuntime();
    const jobId = [...recorded.jobs.keys()][0];

    await drive(runtime, jobId);

    expect(
      recorded.calls.filter((call) => call === "getPullRequestDiff"),
    ).toHaveLength(1);
    expect([...recorded.kv.keys()]).toEqual([`diff:${jobId}`]);
  });

  // A review shouldn't lose its finished file reviews because GitHub hiccuped at the last step.
  it.each([503, 429])(
    "picks a phase back up after GitHub answers %i",
    async (status) => {
      const { runtime, recorded } = createInMemoryRuntime();
      const createGitHub = runtime.createGitHub;
      let outages = 1;
      runtime.createGitHub = ((...args: Parameters<typeof createGitHub>) => {
        const github = createGitHub(...args);
        const getPullRequest = github.getPullRequest.bind(github);
        github.getPullRequest = async (...call) => {
          if (recorded.fileReviews.size > 0 && outages > 0) {
            outages--;
            throw Object.assign(new Error(`GitHub failed with ${status}`), {
              name: "GitHubError",
              status,
            });
          }
          return getPullRequest(...call);
        };
        return github;
      }) as typeof createGitHub;
      const jobId = [...recorded.jobs.keys()][0];

      await drive(runtime, jobId);

      expect(outages).toBe(0);
      expect(recorded.jobs.get(jobId)!.status).toBe("done");
      expect(recorded.postedReviews).toHaveLength(1);
    },
  );

  it("still fails the job when GitHub refuses the request outright", async () => {
    const { runtime, recorded } = createInMemoryRuntime();
    const createGitHub = runtime.createGitHub;
    runtime.createGitHub = ((...args: Parameters<typeof createGitHub>) => {
      const github = createGitHub(...args);
      github.getPullRequest = async () => {
        throw Object.assign(new Error("GitHub failed with 404"), {
          name: "GitHubError",
          status: 404,
        });
      };
      return github;
    }) as typeof createGitHub;
    const jobId = [...recorded.jobs.keys()][0];

    await drive(runtime, jobId);

    expect(recorded.jobs.get(jobId)!.status).toBe("failed");
  });

  it("gives a clean pass a thumbs-up", async () => {
    const { runtime, recorded } = createInMemoryRuntime();

    await drive(runtime, [...recorded.jobs.keys()][0]);

    expect(recorded.reactions).toEqual(["+1"]);
  });

  it("does not call a partial review clean", async () => {
    const { runtime, recorded } = createInMemoryRuntime({
      model: { failPaths: ["src/log.ts"] },
    });

    await drive(runtime, [...recorded.jobs.keys()][0]);

    expect(
      [...recorded.fileReviews.values()].map((row) => row.file_status).sort(),
    ).toEqual(["done", "failed"]);
    expect(recorded.reactions).toEqual([]);
    expect(recorded.checkRuns.at(-1)).toMatchObject({ conclusion: "failure" });
  });

  it("records a terminal failure and closes the check run when the model fails unrecoverably", async () => {
    const { runtime, recorded } = createInMemoryRuntime({
      model: {
        failEveryCall: new Error("provider returned 400: malformed request"),
      },
    });
    const jobId = [...recorded.jobs.keys()][0];

    const results = await drive(runtime, jobId);

    expect(results.at(-1)!.action).toBe("ack");
    expect(
      [...recorded.fileReviews.values()].every(
        (row) => row.file_status === "failed",
      ),
    ).toBe(true);
    expect(recorded.jobs.get(jobId)!.status).toBe("failed");
    expect(recorded.calls).toContain("failJob");
    expect(recorded.checkRuns.at(-1)).toMatchObject({ conclusion: "failure" });
    expect(recorded.postedReviews).toEqual([]);
  });

  it("is deterministic: the clock and id generator are ports, so durations do not vary", async () => {
    const first = createInMemoryRuntime();
    const second = createInMemoryRuntime();

    await drive(first.runtime, [...first.recorded.jobs.keys()][0]);
    await drive(second.runtime, [...second.recorded.jobs.keys()][0]);

    expect(first.recorded.calls).toEqual(second.recorded.calls);
    expect(
      [...first.recorded.fileReviews.values()].map((r) => r.duration_ms),
    ).toEqual(
      [...second.recorded.fileReviews.values()].map((r) => r.duration_ms),
    );
  });

  it("acks without work when the job does not exist", async () => {
    const { runtime } = createInMemoryRuntime();
    expect(
      await runReview(runtime, {
        jobId: "99999999-2222-4333-8444-555555555555",
        phase: "review",
      } as never),
    ).toEqual({ action: "ack" });
  });
});
