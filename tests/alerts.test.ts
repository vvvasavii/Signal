import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { generateApiKey, hashApiKey } from "../src/lib/api-key.js";

// These variables are shared by all tests in this file.
// The API key is kept in plaintext only in test memory so requests can authenticate. The database stores only its hash.
let apiKey: string;
let serviceId: string | undefined;
let serviceName: string;

// Helper function to send an alert to the real Express application.
// Defaults to CRITICAL severity and a standard message when not provided.
function submitAlert(input: {
  dedupKey: string;
  action: "trigger" | "resolve";
  severity?: "INFO" | "WARNING" | "CRITICAL";
  message?: string;
}) {
  return request(app)
    .post("/api/v1/alerts")
    .set("Authorization", `Bearer ${apiKey}`)
    .send({
      service: serviceName,
      environment: "test",
      severity: input.severity ?? "CRITICAL",
      dedupKey: input.dedupKey,
      action: input.action,
      message: input.message ?? "Integration test alert",
      metadata: { source: "vitest" },
    });
}

describe("Alert ingestion", () => {
  // Runs once before the tests.
  // First, verify that the database URL points to signal_test so that
  // the tests cannot accidentally modify the development database.
  // Then create a dedicated service and API key for this test suite.
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL must point to signal_test before running integration tests.",
      );
    }

    const parsedUrl = new URL(databaseUrl);

    if (parsedUrl.pathname !== "/signal_test") {
      throw new Error(
        "Safety check failed: tests may only use the signal_test database.",
      );
    }

    // A unique service name isolates this run from other test runs.
    serviceName = `signal-test-${Date.now()}`;
    apiKey = generateApiKey();

    // Store the API key's hash in PostgreSQL, not its raw value.
    const service = await prisma.service.create({
      data: {
        name: serviceName,
        apiKeys: {
          create: {
            name: "vitest-suite",
            keyHash: hashApiKey(apiKey),
          },
        },
      },
    });

    serviceId = service.id;
  });

  // Runs once after the tests.
  // Remove only records belonging to this test service, then disconnect
  // Prisma so the test process can shut down cleanly.
  afterAll(async () => {
    try {
      if (serviceId) {
        await prisma.alert.deleteMany({
          where: { serviceId },
        });

        await prisma.incident.deleteMany({
          where: { serviceId },
        });

        await prisma.service.delete({
          where: { id: serviceId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  // TEST 1:
  // A new trigger should create an incident and persist the alert.
  // We verify both the HTTP response and the corresponding database rows.
  it("creates an incident for a new trigger", async () => {
    const response = await submitAlert({
      dedupKey: "create-test",
      action: "trigger",
    });

    expect(response.status).toBe(202);
    expect(response.body.outcome).toBe("created");
    expect(response.body.status).toBe("FIRING");
    expect(response.body.alertCount).toBe(1);

    // Verify that the incident actually exists in PostgreSQL.
    const incident = await prisma.incident.findUnique({
      where: { id: response.body.incidentId },
    });

    // Verify that the saved alert is linked to that incident.
    const alert = await prisma.alert.findUnique({
      where: { id: response.body.alertId },
    });

    expect(incident).not.toBeNull();
    expect(alert?.incidentId).toBe(incident?.id);
  });

  // TEST 2:
  // Two triggers with the same service, environment, and dedupKey
  // should attach to one active incident rather than create two incidents.
  // Each trigger should still be stored as a separate alert.
  it("attaches repeated triggers to the same incident", async () => {
    const first = await submitAlert({
      dedupKey: "dedup-test",
      action: "trigger",
    });

    const second = await submitAlert({
      dedupKey: "dedup-test",
      action: "trigger",
    });

    expect(first.body.outcome).toBe("created");
    expect(second.body.outcome).toBe("attached");
    expect(second.body.incidentId).toBe(first.body.incidentId);
    expect(second.body.alertId).not.toBe(first.body.alertId);
    expect(second.body.alertCount).toBe(2);
  });

  // TEST 3:
  // A resolve should close the active incident.
  // A later trigger with the same identity should create a new incident,
  // while the original incident remains resolved.
  it("resolves an incident and creates a new one on a later trigger", async () => {
    const first = await submitAlert({
      dedupKey: "lifecycle-test",
      action: "trigger",
    });

    const resolved = await submitAlert({
      dedupKey: "lifecycle-test",
      action: "resolve",
      message: "Service recovered",
    });

    expect(resolved.body.outcome).toBe("resolved");
    expect(resolved.body.incidentId).toBe(first.body.incidentId);
    expect(resolved.body.status).toBe("RESOLVED");

    const next = await submitAlert({
      dedupKey: "lifecycle-test",
      action: "trigger",
    });

    expect(next.body.outcome).toBe("created");
    expect(next.body.incidentId).not.toBe(first.body.incidentId);
    expect(next.body.alertCount).toBe(1);

    // Confirm that the old incident was not reopened.
    const previousIncident = await prisma.incident.findUnique({
      where: { id: first.body.incidentId },
    });

    expect(previousIncident?.status).toBe("RESOLVED");
  });

  // TEST 4:
  // A resolve with no matching active incident should still be recorded
  // as an alert, but it must not create an incident.
  it("records an unmatched resolve without creating an incident", async () => {
    const response = await submitAlert({
      dedupKey: "unmatched-resolve-test",
      action: "resolve",
    });

    expect(response.body.outcome).toBe("unmatched_resolve");
    expect(response.body.incidentId).toBeNull();

    // Verify the alert exists and has no incident association.
    const alert = await prisma.alert.findUnique({
      where: { id: response.body.alertId },
    });

    // Verify no incident was created for this unmatched resolve.
    const incidents = await prisma.incident.findMany({
      where: {
        serviceId,
        environment: "test",
        dedupKey: "unmatched-resolve-test",
      },
    });

    expect(alert).not.toBeNull();
    expect(alert?.incidentId).toBeNull();
    expect(incidents).toHaveLength(0);
  });

  // TEST 5:
// Verify that PostgreSQL prevents duplicate active incidents
// with the same serviceId, environment, and dedupKey.
// This test bypasses the API route and its advisory lock,
// proving that the database unique index enforces the constraint.
  it("rejects a second active incident with the same identity", async () => {
    const dedupKey = "unique-index-test";

    // Create the first active incident through the API.
    const first = await submitAlert({
      dedupKey,
      action: "trigger",
    });

    expect(first.status).toBe(202);
    expect(first.body.outcome).toBe("created");

    // Try to bypass the alert route and create a duplicate directly.
    // This deliberately skips the advisory lock.
    let caughtError: unknown;

    try {
      await prisma.incident.create({
        data: {
          serviceId: serviceId!,
          environment: "test",
          dedupKey,
          severity: "CRITICAL",
          policySnapshot: {},
        },
      });
    } catch (error) {
      caughtError = error;
    }

    // The database should reject the duplicate.
    expect(caughtError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    expect((caughtError as Prisma.PrismaClientKnownRequestError).code).toBe(
      "P2002",
    );


    // The original incident must still be the only active incident.
    const activeIncidents = await prisma.incident.findMany({
      where: {
        serviceId,
        environment: "test",
        dedupKey,
        status: { in: ["FIRING", "ACKNOWLEDGED"] },
      },
    });

    expect(activeIncidents).toHaveLength(1);
    expect(activeIncidents[0].id).toBe(first.body.incidentId);
  });

 // TEST 6:
// Send 500 trigger requests concurrently with the same identity.
// Verify that exactly one incident is created, the other 499 alerts
// attach to it, every alert is persisted, and alertCount reaches 500.

  it("uses one incident for 500 concurrent triggers", async () => {
    const requestCount = 500;
    const dedupKey = "concurrent-500-test";

    // Send all 500 requests without waiting for earlier requests to finish.
    const responses = await Promise.all(
      Array.from({ length: requestCount }, () =>
        submitAlert({
          dedupKey,
          action: "trigger",
        }),
      ),
    );

    // Every request should be accepted by the API.

    const statusCounts = responses.reduce<Record<number, number>>(
      (counts, response) => {
        counts[response.status] = (counts[response.status] ?? 0) + 1;
        return counts;
      },
      {},
    );

    const failedResponses = responses
      .filter((response) => response.status !== 202)
      .slice(0, 10)
      .map((response) => ({
        status: response.status,
        body: response.body,
        text: response.text,
      }));

    if (failedResponses.length > 0) {
      throw new Error(
        [
          "Some concurrent alert requests failed.",
          `HTTP status counts: ${JSON.stringify(statusCounts)}`,
          `Sample failed responses: ${JSON.stringify(failedResponses, null, 2)}`,
        ].join("\n"),
      );
    }

    expect(responses.every((response) => response.status === 202)).toBe(true);

    // Exactly one request creates the incident.
    // All remaining requests attach to that same incident.
    const outcomes = responses.map((response) => response.body.outcome);

    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);

    expect(outcomes.filter((outcome) => outcome === "attached")).toHaveLength(
      requestCount - 1,
    );

    // Every response must refer to the same incident.
    const incidentIds = new Set(
      responses.map((response) => response.body.incidentId),
    );

    expect(incidentIds.size).toBe(1);

    // Every request must produce its own alert record.
    const alertIds = new Set(
      responses.map((response) => response.body.alertId),
    );

    expect(alertIds.size).toBe(requestCount);

    // Verify that the incident in the database has the correct alertCount.
    const incidentId = responses[0].body.incidentId;

    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });

    expect(incident).not.toBeNull();
    expect(incident?.status).toBe("FIRING");
    expect(incident?.alertCount).toBe(requestCount);

    // Confirm that only one active incident exists for this identity.
    const activeIncidents = await prisma.incident.findMany({
      where: {
        serviceId,
        environment: "test",
        dedupKey,
        status: {
          in: ["FIRING", "ACKNOWLEDGED"],
        },
      },
    });

    expect(activeIncidents).toHaveLength(1);
  }, 60_000); // 60 seconds timeout for this test
});
