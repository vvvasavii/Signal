import {
  EscalationAttemptState,
  IncidentStatus,
  NotificationState,
  EscalationState,
  Prisma,
} from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { escalationQueue } from "../queues/escalation.queue.js";

// Possible outcomes when attempting to claim the initial escalation.
type ClaimResult =
  | { outcome: "claimed"; notificationAttemptId: string }
  | {
      outcome:
        | "not_found"
        | "not_due"
        | "inactive"
        | "already_claimed"
        | "no_policy_step";
    };

// We only need the step index to verify that step 0 exists
// in the incident's immutable policy snapshot.
type PolicySnapshotStep = {
  stepIndex: number;
};

// Validate untrusted JSON before reading its properties.
// Prisma's Json field does not guarantee this runtime shape.
function isPolicySnapshotStep(value: unknown): value is PolicySnapshotStep {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const step = value as Record<string, unknown>;

  return Number.isInteger(step.stepIndex);
}

export async function claimInitialEscalation(
  incidentId: string,
  now = new Date(),
): Promise<ClaimResult> {
  return prisma.$transaction(
    async (tx) => {
      // Lock this incident so ACK, resolve, and concurrent schedulers
      // serialize their changes to the same row.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM "Incident"
        WHERE id = ${incidentId}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        return { outcome: "not_found" };
      }

      // Read the state after obtaining the lock.
      const incident = await tx.incident.findUnique({
        where: { id: incidentId },
        select: {
          id: true,
          status: true,
          severity: true,
          nextActionAt: true,
          escalationState: true,
          policySnapshot: true,
        },
      });

      if (!incident) {
        return { outcome: "not_found" };
      }

      // Only a firing incident can start a new escalation.
      if (incident.status !== IncidentStatus.FIRING) {
        return { outcome: "inactive" };
      }

      // Do not process incidents whose escalation chain is exhausted.
      if (incident.escalationState !== EscalationState.ACTIVE) {
        return { outcome: "inactive" };
      }

      // The scheduler must not run before the database deadline.
      if (incident.nextActionAt === null || incident.nextActionAt > now) {
        return { outcome: "not_due" };
      }

      // INFO incidents do not trigger escalation notifications.
      if (incident.severity === "INFO") {
        return { outcome: "no_policy_step" };
      }

      // Validate the policy snapshot and locate the initial step.
      const snapshot = incident.policySnapshot;

      if (
        typeof snapshot !== "object" ||
        snapshot === null ||
        !("steps" in snapshot) ||
        !Array.isArray(snapshot.steps)
      ) {
        return { outcome: "no_policy_step" };
      }

      const steps = snapshot.steps.filter(isPolicySnapshotStep);
      const initialStep = steps.find((step) => step.stepIndex === 0);

      if (!initialStep) {
        return { outcome: "no_policy_step" };
      }

      // The unique constraint on (incidentId, stepIndex) is the
      // database-level safeguard against duplicate escalation attempts.
      const existingAttempt = await tx.escalationAttempt.findUnique({
        where: {
          incidentId_stepIndex: {
            incidentId,
            stepIndex: 0,
          },
        },
        select: {
          notificationAttempt: {
            select: { id: true },
          },
        },
      });

      if (existingAttempt) {
        // Do not create a second attempt if one already exists.
        // A missing notification is an inconsistency to investigate,
        // not permission to duplicate the escalation.
        return { outcome: "already_claimed" };
      }

      // Create the escalation record and its pending notification
      // in the same transaction, so they cannot partially commit.
      const attempt = await tx.escalationAttempt.create({
        data: {
          incidentId,
          stepIndex: 0,
          state: EscalationAttemptState.PENDING,
        },
      });

      const notification = await tx.notificationAttempt.create({
        data: {
          escalationAttemptId: attempt.id,
          state: NotificationState.PENDING,
          nextAttemptAt: now,
        },
      });

      await tx.incident.update({
        where: { id: incidentId },
        data: { nextActionAt: null },
      });

      // Add an audit event to the incident timeline.
      await tx.incidentEvent.create({
        data: {
          incidentId,
          type: "ESCALATION_SCHEDULED",
          source: "escalation_scheduler",
          metadata: {
            stepIndex: 0,
            escalationAttemptId: attempt.id,
            notificationAttemptId: notification.id,
          },
        },
      });

      return {
        outcome: "claimed",
        notificationAttemptId: notification.id,
      };
    },
    {
      maxWait: 5000,
      timeout: 10000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}


export async function scheduleInitialEscalation(
  incidentId: string,
): Promise<ClaimResult> {
  // First, claim the escalation in PostgreSQL.
  // The transaction must commit before we enqueue the job.
  const result = await claimInitialEscalation(incidentId);

  if (result.outcome !== "claimed") {
    return result;
  }

  // Use the notification ID for a deterministic job ID.
  // Retrying this enqueue won't create a second job with the same ID
  // while BullMQ retains the existing job.
  await escalationQueue.add(
    "deliver-notification",
    {
      notificationAttemptId: result.notificationAttemptId,
    },
    {
      jobId: `notification-${result.notificationAttemptId}`,
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: false,
      removeOnFail: false,
    },
  );

  return result;
}

