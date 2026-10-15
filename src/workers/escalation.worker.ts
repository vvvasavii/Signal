import { Job, Worker } from "bullmq";
import {
  EscalationAttemptState,
  EscalationState,
  IncidentStatus,
  NotificationState,
} from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { redisConnection } from "../lib/redis.js";
// Reuse Signal's existing HMAC-signed, expiring ACK token.
import { createAckToken } from "../lib/ack-token.js";

// Keep job data small. PostgreSQL stores the actual notification state.
type EscalationJobData = {
  notificationAttemptId: string;
};

type PolicySnapshotStep = {
  stepIndex: number;
  userId: string;
  userName: string;
  notificationTarget: string | null;
};

type PolicySnapshot = {
  steps?: unknown[];
};

// JSON stored in PostgreSQL needs runtime validation before we trust its shape.
function isPolicySnapshotStep(value: unknown): value is PolicySnapshotStep {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const step = value as Record<string, unknown>;

  return (
    typeof step.stepIndex === "number" &&
    typeof step.userId === "string" &&
    typeof step.userName === "string" &&
    (typeof step.notificationTarget === "string" ||
      step.notificationTarget === null)
  );
}

function getPolicyStep(
  snapshotValue: unknown,
  stepIndex: number,
): PolicySnapshotStep | null {
  if (
    typeof snapshotValue !== "object" ||
    snapshotValue === null ||
    !("steps" in snapshotValue)
  ) {
    return null;
  }

  const snapshot = snapshotValue as PolicySnapshot;

  if (!Array.isArray(snapshot.steps)) {
    return null;
  }

  const step = snapshot.steps.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "stepIndex" in candidate &&
      candidate.stepIndex === stepIndex,
  );

  return isPolicySnapshotStep(step) ? step : null;
}

// Validate the configured destination before sending incident data to it.
// Keep this URL in an environment variable, never in the incident payload.
function getSlackWebhookUrl(): URL {
  const configuredUrl = process.env.SLACK_WEBHOOK_URL;

  if (!configuredUrl) {
    throw new Error("SLACK_WEBHOOK_URL is not configured");
  }

  const url = new URL(configuredUrl);

  // This first implementation targets Slack's official incoming webhooks.
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") {
    throw new Error("SLACK_WEBHOOK_URL must use HTTPS and hooks.slack.com");
  }

  return url;
}

async function processNotification(job: Job<EscalationJobData>): Promise<void> {
  const { notificationAttemptId } = job.data;

  // Claim the notification in a DB transaction before making an external call.
  // The incident row lock serializes this check against ACK and resolve updates.
  const preparation = await prisma.$transaction(async (tx) => {
    const initialAttempt = await tx.notificationAttempt.findUnique({
      where: { id: notificationAttemptId },
      include: {
        escalationAttempt: {
          include: {
            incident: true,
          },
        },
      },
    });

    if (!initialAttempt) {
      throw new Error(
        `Notification attempt ${notificationAttemptId} was not found`,
      );
    }

    const incidentId = initialAttempt.escalationAttempt.incidentId;

    await tx.$queryRaw`
      SELECT id
      FROM "Incident"
      WHERE id = ${incidentId}
      FOR UPDATE
    `;

    // Read again after acquiring the lock so we use the current DB state.
    const attempt = await tx.notificationAttempt.findUnique({
      where: { id: notificationAttemptId },
      include: {
        escalationAttempt: {
          include: {
            incident: {
              include: { service: true },
            },
          },
        },
      },
    });

    if (!attempt) {
      throw new Error(
        `Notification attempt ${notificationAttemptId} disappeared`,
      );
    }

    if (attempt.state === NotificationState.SENT) {
      // A completed notification must never be deliberately sent again.
      return { kind: "already_sent" as const };
    }

    // Another worker may already be delivering this notification.
    // Do not let a duplicate BullMQ job send it concurrently.
    if (attempt.state === NotificationState.SENDING) {
      return { kind: "already_processing" as const };
    }

    // Only fresh or retryable notifications may proceed.
    // The incident row lock serializes workers making this decision.
    if (
      attempt.state !== NotificationState.PENDING &&
      attempt.state !== NotificationState.FAILED
    ) {
      return { kind: "not_eligible" as const };
    }

    const incident = attempt.escalationAttempt.incident;

    // An ACK or resolve may have committed while this job waited in Redis.
    if (
      incident.status !== IncidentStatus.FIRING ||
      incident.severity === "INFO" ||
      incident.escalationState !== EscalationState.ACTIVE
    ) {
      await tx.notificationAttempt.update({
        where: { id: attempt.id },
        data: {
          state: NotificationState.FAILED,
          error: "Incident is no longer eligible for escalation",
          nextAttemptAt: null,
        },
      });

      await tx.escalationAttempt.update({
        where: { id: attempt.escalationAttemptId },
        data: { state: EscalationAttemptState.SKIPPED },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId: incident.id,
          type: "ESCALATION_SKIPPED",
          source: "worker",
          metadata: {
            notificationAttemptId: attempt.id,
            reason: "incident_not_eligible",
          },
        },
      });

      // NotificationState has no SKIPPED value, so the escalation attempt
      // records the skip while the notification stores the reason.
      return { kind: "skipped" as const };
    }

    const step = getPolicyStep(
      incident.policySnapshot,
      attempt.escalationAttempt.stepIndex,
    );

    if (!step) {
      throw new Error(
        `Policy snapshot is missing step ${attempt.escalationAttempt.stepIndex}`,
      );
    }

    // Persist SENDING before the HTTP request. A crashed worker can be
    // recovered later by the sweeper, although delivery remains at-least-once.
    await tx.notificationAttempt.update({
      where: { id: attempt.id },
      data: {
        state: NotificationState.SENDING,
        error: null,
      },
    });

    return {
      kind: "ready" as const,
      notificationAttemptId: attempt.id,
      escalationAttemptId: attempt.escalationAttemptId,
      incidentId: incident.id,
      serviceName: incident.service.name,
      environment: incident.environment,
      dedupKey: incident.dedupKey,
      severity: incident.severity,
      alertCount: incident.alertCount,
      // Bind the acknowledgement token to the intended responder.
      responderName: step.userName,
      responderUserId: step.userId,
      notificationTarget: step.notificationTarget,
    };
  });

  if (preparation.kind !== "ready") {
    return;
  }

  
  try {
    const webhookUrl = getSlackWebhookUrl();

    // Create a token bound to this incident and its intended responder.
    const ackToken = createAckToken(
      preparation.incidentId,
      preparation.responderUserId,
    );

    // This must be the publicly reachable API base URL in production.
    const appBaseUrl = process.env.APP_BASE_URL;

    if (!appBaseUrl) {
      throw new Error("APP_BASE_URL is not configured");
    }

    const ackUrl = new URL(
      `/api/v1/incidents/${encodeURIComponent(preparation.incidentId)}/acknowledge/confirm`,
      appBaseUrl,
    );

    // The confirmation page validates the token before showing the button.
    ackUrl.searchParams.set("token", ackToken);

    // Send the incident details and signed ACK link to Slack.
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        text: [
          `🚨 *${preparation.severity} incident*`,
          `Service: ${preparation.serviceName}`,
          `Environment: ${preparation.environment}`,
          `Incident: ${preparation.incidentId}`,
          `Dedup key: ${preparation.dedupKey}`,
          `Alert count: ${preparation.alertCount}`,
          `Responder: ${preparation.responderName}`,
          `Acknowledge: ${ackUrl.toString()}`,
        ].join("\n"),
      }),
    });

    if (!response.ok) {
      // Throw so BullMQ can apply the configured retry policy.
      throw new Error(
        `Slack webhook returned HTTP ${response.status}`,
      );
    }

    // Record delivery success and its timeline event atomically.
    await prisma.$transaction(async (tx) => {
      await tx.notificationAttempt.update({
        where: { id: preparation.notificationAttemptId },
        data: {
          state: NotificationState.SENT,
          sentAt: new Date(),
          nextAttemptAt: null,
          error: null,
        },
      });

      await tx.escalationAttempt.update({
        where: { id: preparation.escalationAttemptId },
        data: {
          state: EscalationAttemptState.COMPLETED,
          completedAt: new Date(),
        },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId: preparation.incidentId,
          type: "NOTIFICATION_SENT",
          source: "worker",
          metadata: {
            notificationAttemptId:
              preparation.notificationAttemptId,
            channel: "slack_webhook",
          },
        },
      });
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown delivery error";

    // Match the exponential backoff used by the BullMQ job.
    const currentAttempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const hasBullMqRetryRemaining = currentAttempt < maxAttempts;

    const retryDelayMs = 1_000 * 2 ** job.attemptsMade;
    const nextAttemptAt = new Date(Date.now() + retryDelayMs);

    // Persist the failure so the sweeper can recover exhausted jobs.
    await prisma.$transaction(async (tx) => {
      await tx.notificationAttempt.update({
        where: { id: preparation.notificationAttemptId },
        data: {
          state: NotificationState.FAILED,
          retryCount: { increment: 1 },
          nextAttemptAt: hasBullMqRetryRemaining
            ? nextAttemptAt
            : new Date(),
          error: message.slice(0, 1_000),
        },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId: preparation.incidentId,
          type: "NOTIFICATION_FAILED",
          source: "worker",
          metadata: {
            notificationAttemptId:
              preparation.notificationAttemptId,
            attemptNumber: currentAttempt,
            error: message.slice(0, 500),
          },
        },
      });
    });

    // BullMQ must receive the error to trigger its retry mechanism.
    throw error;
  }

}

// The queue name must match src/queues/escalation.queue.ts exactly.
export const escalationWorker = new Worker<EscalationJobData>(
  "signal-escalations",
  processNotification,
  {
    connection: redisConnection,
    concurrency: 10,
  },
);

// These listeners make worker failures visible during development and in logs.
escalationWorker.on("completed", (job) => {
  console.info(`Escalation job completed: ${job.id}`);
});

escalationWorker.on("failed", (job, error) => {
  console.error(
    `Escalation job failed: ${job?.id ?? "unknown"}`,
    error.message,
  );
});

escalationWorker.on("error", (error) => {
  console.error("Escalation worker error:", error);
});
