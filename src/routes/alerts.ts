import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { authenticateApiKey } from "../middleware/authenticate-api-key.js";
import { alertSchema } from "../schemas/alert.schema.js";



function isActiveIncidentUniqueConflict(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  return error.message.includes(
    "Incident_one_unresolved_per_dedup_key",
  );
}


const router = Router();

const severityRank = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
} as const;

router.post("/", authenticateApiKey, async (req, res) => {
  const result = alertSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid alert payload",
      details: result.error.issues,
    });
  }

  const alert = result.data;
  const serviceId: string = res.locals.serviceId;
  const receivedAt = new Date();

  try {
    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        escalationPolicy: {
          include: {
            steps: {
              orderBy: { stepIndex: "asc" },
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    notificationTarget: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!service) {
      return res.status(401).json({
        error: "Authenticated service not found",
      });
    }

    if (alert.service !== service.name) {
      return res.status(403).json({
        error: "Alert service does not match API key",
      });
    }

    const payload = JSON.parse(JSON.stringify(alert)) as Prisma.InputJsonValue;

    const outcome = await prisma.$transaction(async (tx) => {
      //usuing tx in place of prisma to ensure that all operations are atomic and consistent
      // Serialize processing for this exact service/environment/key.
      // The transaction-scoped lock is released automatically at commit.
      const lockIdentity = JSON.stringify([alert.environment, alert.dedupKey]);

      // Serialize processing for the same service/environment/dedup key.

      await tx.$queryRaw`
  SELECT 1 AS locked
  FROM (
    SELECT pg_advisory_xact_lock(
      hashtext(${serviceId}),
      hashtext(${lockIdentity})
    )
  ) AS lock_result
`;

      const activeIncident = await tx.incident.findFirst({
        where: {
          serviceId,
          environment: alert.environment,
          dedupKey: alert.dedupKey,
          status: { in: ["FIRING", "ACKNOWLEDGED"] },
        },
      });

      // A resolve without an active incident is still recorded.
      if (alert.action === "resolve" && !activeIncident) {
        const savedAlert = await tx.alert.create({
          data: {
            serviceId,
            environment: alert.environment,
            dedupKey: alert.dedupKey,
            action: alert.action,
            severity: alert.severity,
            message: alert.message,
            receivedAt,
            clientTimestamp: alert.timestamp ? new Date(alert.timestamp) : null,
            payload,
          },
        });

        return {
          outcome: "unmatched_resolve" as const,
          alertId: savedAlert.id,
          incidentId: null,
        };
      }

      if (alert.action === "resolve" && activeIncident) {
        const savedAlert = await tx.alert.create({
          data: {
            serviceId,
            incidentId: activeIncident.id,
            environment: alert.environment,
            dedupKey: alert.dedupKey,
            action: alert.action,
            severity: alert.severity,
            message: alert.message,
            receivedAt,
            clientTimestamp: alert.timestamp ? new Date(alert.timestamp) : null,
            payload,
          },
        });

        const incident = await tx.incident.update({
          where: { id: activeIncident.id },
          data: {
            status: "RESOLVED",
            resolvedAt: receivedAt,
            nextActionAt: null,
            escalationState: "EXHAUSTED",
          },
        });

        await tx.incidentEvent.create({
          data: {
            incidentId: incident.id,
            type: "ALERT_RESOLVED",
            source: "api",
            metadata: {
              alertId: savedAlert.id,
              message: alert.message,
            },
          },
        });

        return {
          outcome: "resolved" as const,
          alertId: savedAlert.id,
          incidentId: incident.id,
          status: incident.status,
        };
      }

      let incident;

      if (activeIncident) {
        const upgradedSeverity =
          severityRank[alert.severity] > severityRank[activeIncident.severity]
            ? alert.severity
            : activeIncident.severity;

        const snapshot = activeIncident.policySnapshot as {
          steps?: unknown[];
        };

        const shouldStartEscalation =
          activeIncident.status === "FIRING" &&
          activeIncident.severity === "INFO" &&
          upgradedSeverity !== "INFO" &&
          Array.isArray(snapshot.steps) &&
          snapshot.steps.length > 0;

        incident = await tx.incident.update({
          where: { id: activeIncident.id },
          data: {
            alertCount: { increment: 1 },
            severity: upgradedSeverity,
            ...(shouldStartEscalation ? { nextActionAt: receivedAt } : {}),
          },
        });
      } else {
        const policy = service.escalationPolicy;

        const policySnapshot = {
          policyId: policy?.id ?? null,
          policyName: policy?.name ?? null,
          steps: (policy?.steps ?? []).map((step) => ({
            stepIndex: step.stepIndex,
            delaySeconds: step.delaySeconds,
            userId: step.user.id,
            userName: step.user.name,
            notificationTarget: step.user.notificationTarget,
          })),
        } satisfies Prisma.InputJsonObject;

        const shouldScheduleEscalation =
          alert.severity !== "INFO" && policySnapshot.steps.length > 0;

        incident = await tx.incident.create({
          data: {
            serviceId,
            environment: alert.environment,
            dedupKey: alert.dedupKey,
            severity: alert.severity,
            policySnapshot,
            nextActionAt: shouldScheduleEscalation ? receivedAt : null,
          },
        });
      }

      const savedAlert = await tx.alert.create({
        data: {
          serviceId,
          incidentId: incident.id,
          environment: alert.environment,
          dedupKey: alert.dedupKey,
          action: alert.action,
          severity: alert.severity,
          message: alert.message,
          receivedAt,
          clientTimestamp: alert.timestamp ? new Date(alert.timestamp) : null,
          payload,
        },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId: incident.id,
          type: activeIncident ? "ALERT_ATTACHED" : "INCIDENT_TRIGGERED",
          source: "api",
          metadata: {
            alertId: savedAlert.id,
            severity: alert.severity,
            message: alert.message,
          },
        },
      });

      return {
        outcome: activeIncident ? ("attached" as const) : ("created" as const),
        alertId: savedAlert.id,
        incidentId: incident.id,
        status: incident.status,
        severity: incident.severity,
        alertCount: incident.alertCount,
      };
          }, {
      maxWait: 30_000,
      timeout: 30_000,
    });

    return res.status(202).json(outcome);
  } catch (error) {
    if (
      alert.action === "trigger" &&
      isActiveIncidentUniqueConflict(error)
    ) {
      try {
        const recoveredOutcome = await prisma.$transaction(
          async (tx) => {
            // Reacquire the same lock after the failed transaction rolled back.
            const lockIdentity = JSON.stringify([
              alert.environment,
              alert.dedupKey,
            ]);

            await tx.$queryRaw`
              SELECT 1 AS locked
              FROM (
                SELECT pg_advisory_xact_lock(
                  hashtext(${serviceId}),
                  hashtext(${lockIdentity})
                )
              ) AS lock_result
            `;

            // The conflicting incident should now be visible.
            const activeIncident = await tx.incident.findFirst({
              where: {
                serviceId,
                environment: alert.environment,
                dedupKey: alert.dedupKey,
                status: { in: ["FIRING", "ACKNOWLEDGED"] },
              },
            });

            // It may have been resolved before recovery started.
            // Do not blindly attach the alert to an inactive incident.
            if (!activeIncident) {
              return null;
            }

            const upgradedSeverity =
              severityRank[alert.severity] >
              severityRank[activeIncident.severity]
                ? alert.severity
                : activeIncident.severity;

            const snapshot = activeIncident.policySnapshot as {
              steps?: unknown[];
            };

            const shouldStartEscalation =
              activeIncident.status === "FIRING" &&
              activeIncident.severity === "INFO" &&
              upgradedSeverity !== "INFO" &&
              Array.isArray(snapshot.steps) &&
              snapshot.steps.length > 0;

            // Reuse the existing incident and update it atomically.
            const incident = await tx.incident.update({
              where: { id: activeIncident.id },
              data: {
                alertCount: { increment: 1 },
                severity: upgradedSeverity,
                ...(shouldStartEscalation
                  ? { nextActionAt: receivedAt }
                  : {}),
              },
            });

            const payload = JSON.parse(
              JSON.stringify(alert),
            ) as Prisma.InputJsonValue;

            const savedAlert = await tx.alert.create({
              data: {
                serviceId,
                incidentId: incident.id,
                environment: alert.environment,
                dedupKey: alert.dedupKey,
                action: alert.action,
                severity: alert.severity,
                message: alert.message,
                receivedAt,
                clientTimestamp: alert.timestamp
                  ? new Date(alert.timestamp)
                  : null,
                payload,
              },
            });

            await tx.incidentEvent.create({
              data: {
                incidentId: incident.id,
                type: "ALERT_ATTACHED",
                source: "api",
                metadata: {
                  alertId: savedAlert.id,
                  severity: alert.severity,
                  message: alert.message,
                },
              },
            });

            return {
              outcome: "attached" as const,
              alertId: savedAlert.id,
              incidentId: incident.id,
              status: incident.status,
              severity: incident.severity,
              alertCount: incident.alertCount,
            };
          },
          {
            maxWait: 30_000,
            timeout: 30_000,
          },
        );

        if (recoveredOutcome) {
          return res.status(202).json(recoveredOutcome);
        }
      } catch (recoveryError) {
        console.error(
          "Failed to recover from active incident conflict:",
          recoveryError,
        );
      }
    }

    console.error("Failed to process alert:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
