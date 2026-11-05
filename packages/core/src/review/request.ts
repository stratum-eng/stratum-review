import type {
  WebhookEventName,
  WebhookPayload,
  CommentWebhookPayload,
  ChangeRequestWebhookPayload,
} from "@codraoss/schema/webhook";
import type { RepoConfig } from "@codraoss/schema";

function shouldTriggerFromChangeRequest(
  action: ChangeRequestWebhookPayload["action"],
  config: RepoConfig["review"],
) {
  return (config.on as string[]).includes(action);
}

// Each mention spends model budget, and anyone on GitHub can comment on a public repository's pull requests.
const MENTION_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function canRequestReview(comment: CommentWebhookPayload["comment"]) {
  return (
    comment.authorType !== "Bot" &&
    MENTION_ASSOCIATIONS.has(comment.authorAssociation ?? "")
  );
}

// A plain substring would also fire on `@stratum-reviewer` or `me@stratum-review.dev`.
function mentions(body: string, trigger: string) {
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w@./-])${escaped}(?![\\w-])`, "i").test(body);
}

export type ReviewRequest = {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prAuthor: string | null;
  commitSha: string;
  baseSha: string;
  headRef: string | null;
  baseRef: string | null;
  trigger: "auto" | "mention";
};

export function extractReviewRequest(input: {
  eventName: WebhookEventName;
  payload: WebhookPayload;
  botUsername: string;
  config: RepoConfig;
}): ReviewRequest | null {
  if (input.eventName === "change_request") {
    const payload = input.payload as ChangeRequestWebhookPayload;
    if (input.config.review.ignore_drafts && payload.changeRequest.draft) {
      return null;
    }
    if (!shouldTriggerFromChangeRequest(payload.action, input.config.review)) {
      return null;
    }

    return {
      installationId: payload.installationId,
      owner: payload.repository.owner,
      repo: payload.repository.name,
      prNumber: payload.changeRequest.number,
      prTitle: payload.changeRequest.title,
      prAuthor: payload.changeRequest.author,
      commitSha: payload.changeRequest.head.sha,
      baseSha: payload.changeRequest.base.sha,
      headRef: payload.changeRequest.head.ref,
      baseRef: payload.changeRequest.base.ref,
      trigger: "auto" as const,
    };
  }

  if (input.eventName === "comment") {
    const payload = input.payload as CommentWebhookPayload;
    const mentionTrigger = input.config.review.mention_trigger;

    if (
      !payload.issue.isChangeRequest ||
      payload.action !== "created" ||
      !mentionTrigger
    ) {
      return null;
    }

    if (
      !mentions(payload.comment.body, mentionTrigger) ||
      !canRequestReview(payload.comment)
    ) {
      return null;
    }

    return {
      installationId: payload.installationId,
      owner: payload.repository.owner,
      repo: payload.repository.name,
      prNumber: payload.issue.number,
      prTitle: null,
      prAuthor: null,
      commitSha: "",
      baseSha: "",
      headRef: null,
      baseRef: null,
      trigger: "mention" as const,
    };
  }

  return null;
}
