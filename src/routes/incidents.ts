
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyAckToken } from "../lib/ack-token.js";

const router = Router();

router.post("/:id/acknowledge", async (req, res) => {
  const incidentId = req.params.id;
  const token = req.body?.token;

  if (typeof token !== "string" || !token) {
    return res.status(400).json({
      error: "Acknowledgement token is required",
    });
  }

  const claims = verifyAckToken(token);

  if (!claims || claims.incidentId !== incidentId) {
    return res.status(401).json({
      error: "Invalid or expired acknowledgement token",
    });
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Lock this incident row so acknowledgement and escalation
      // can coordinate their decisions.
      const rows = await tx.$queryRaw<
        { id: string; status: string }[]
      >`
        SELECT "id", "status"
        FROM "Incident"
        WHERE "id" = ${incidentId}
        FOR UPDATE
      `;

      const incident = rows[0];

      if (!incident) {
        return { outcome: "not_found" as const };
      }

      // Check the status again after obtaining the lock.
      const current = await tx.incident.findUniqueOrThrow({
        where: { id: incidentId },
      });

      if (current.status === "RESOLVED") {
        return { outcome: "already_resolved" as const };
      }

      if (current.status === "ACKNOWLEDGED") {
        return { outcome: "already_acknowledged" as const };
      }

      const acknowledgedAt = new Date();

      await tx.incident.update({
        where: { id: incidentId },
        data: {
          status: "ACKNOWLEDGED",
          acknowledgedAt,
          acknowledgedById: claims.userId,
          nextActionAt: null,
        },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId,
          type: "INCIDENT_ACKNOWLEDGED",
          source: "signed_ack_link",
          metadata: {
            userId: claims.userId,
            acknowledgedAt: acknowledgedAt.toISOString(),
          },
        },
      });

      return { outcome: "acknowledged" as const };
    });

    if (outcome.outcome === "not_found") {
      return res.status(404).json({ error: "Incident not found" });
    }

    if (outcome.outcome === "already_resolved") {
      return res.status(409).json({
        error: "Resolved incidents cannot be acknowledged",
      });
    }

    return res.status(200).json(outcome);
  } catch (error) {
    console.error("Failed to acknowledge incident:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

export default router;
