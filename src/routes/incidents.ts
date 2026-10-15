import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyAckToken } from "../lib/ack-token.js";

const router = Router();

// Escape values before inserting them into HTML.
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[char]!;
  });
}

// GET displays a confirmation page only. It must never acknowledge
// an incident automatically because link scanners may open URLs.
router.get("/:id/acknowledge/confirm", (req, res) => {
  const incidentId = req.params.id;
  const token = req.query.token;

  if (typeof token !== "string" || !token) {
    return res.status(400).send("Acknowledgement token is required.");
  }

  const claims = verifyAckToken(token);

  if (!claims || claims.incidentId !== incidentId) {
    return res.status(401).send("Invalid or expired acknowledgement link.");
  }

  // Prevent browsers and intermediaries from caching this token-bearing page.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const safeIncidentId = escapeHtml(incidentId);
  const safeToken = escapeHtml(token);

  // No external scripts, stylesheets, images, or analytics on this page.
  return res.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Acknowledge Signal Incident</title>
      </head>
      <body>
        <main>
          <h1>Acknowledge incident?</h1>
          <p>Incident: <strong>${safeIncidentId}</strong></p>
          <p>Confirm that you are taking responsibility for this incident.</p>

          <button id="ack-button" type="button">
            Acknowledge incident
          </button>

          <p id="result" role="status"></p>
        </main>

        <script>
          const button = document.getElementById("ack-button");
          const result = document.getElementById("result");

          button.addEventListener("click", async () => {
            // Require an explicit click before changing incident state.
            button.disabled = true;
            result.textContent = "Submitting acknowledgement...";

            try {
              const response = await fetch(
                "/api/v1/incidents/${encodeURIComponent(incidentId)}/acknowledge",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({ token: "${safeToken}" })
                }
              );

              const data = await response.json();

              if (!response.ok) {
                throw new Error(
                  data.error || "Acknowledgement failed."
                );
              }

              result.textContent =
                data.outcome === "already_acknowledged"
                  ? "This incident has already been acknowledged."
                  : "Incident acknowledged successfully.";
            } catch (error) {
              result.textContent =
                error instanceof Error
                  ? error.message
                  : "Acknowledgement failed.";

              button.disabled = false;
            }
          });
        </script>
      </body>
    </html>
  `);
});

// Keep your existing POST /:id/acknowledge route below this point.
// It remains responsible for validating and recording the ACK.

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
      // Lock the incident so ACK and escalation can coordinate.
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id", "status"
        FROM "Incident"
        WHERE "id" = ${incidentId}
        FOR UPDATE
      `;

      if (!rows[0]) {
        return { outcome: "not_found" as const };
      }

      // Read the current status while holding the row lock.
      const current = await tx.incident.findUniqueOrThrow({
        where: { id: incidentId },
      });

      if (current.status === "RESOLVED") {
        return { outcome: "already_resolved" as const };
      }

      // Repeated ACKs succeed without generating duplicate events.
      if (current.status === "ACKNOWLEDGED") {
        return { outcome: "already_acknowledged" as const };
      }

      // A valid signature does not guarantee that the user still exists.
      const user = await tx.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      });

      if (!user) {
        return { outcome: "invalid_user" as const };
      }

      const acknowledgedAt = new Date();

      await tx.incident.update({
        where: { id: incidentId },
        data: {
          status: "ACKNOWLEDGED",
          acknowledgedAt,
          acknowledgedById: user.id,
          nextActionAt: null,
        },
      });

      await tx.incidentEvent.create({
        data: {
          incidentId,
          type: "INCIDENT_ACKNOWLEDGED",
          source: "signed_ack_link",
          metadata: {
            userId: user.id,
            acknowledgedAt: acknowledgedAt.toISOString(),
          },
        },
      });

      return { outcome: "acknowledged" as const };
    });

    if (outcome.outcome === "not_found") {
      return res.status(404).json({
        error: "Incident not found",
      });
    }

    if (outcome.outcome === "already_resolved") {
      return res.status(409).json({
        error: "Resolved incidents cannot be acknowledged",
      });
    }

    if (outcome.outcome === "invalid_user") {
      return res.status(401).json({
        error: "Acknowledgement token refers to an invalid user",
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
