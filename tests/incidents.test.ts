
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";

import app from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createAckToken } from "../src/lib/ack-token.js";

const ACK_SECRET =
  process.env.ACK_TOKEN_SECRET ??
  "test-ack-token-secret-with-at-least-32-chars";

process.env.ACK_TOKEN_SECRET = ACK_SECRET;

let serviceId: string;
let userId: string;
let serviceName: string;
let incidentCounter = 0;

function expiredAckToken(incidentId: string, userId: string) {
  const payload = {
    incidentId,
    userId,
    action: "acknowledge",
    exp: Math.floor(Date.now() / 1000) - 60,
  };

  const encodedPayload = Buffer
    .from(JSON.stringify(payload))
    .toString("base64url");

  const signature = createHmac("sha256", ACK_SECRET)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

async function createIncident(
  status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED" = "FIRING",
) {
  incidentCounter++;

  return prisma.incident.create({
    data: {
      serviceId,
      environment: "test",
      dedupKey: `ack-test-${Date.now()}-${incidentCounter}`,
      severity: "CRITICAL",
      status,
      policySnapshot: {},
      nextActionAt: new Date(Date.now() + 60_000),
      ...(status === "RESOLVED"
        ? { resolvedAt: new Date() }
        : {}),
      ...(status === "ACKNOWLEDGED"
        ? {
            acknowledgedAt: new Date(),
            acknowledgedById: userId,
          }
        : {}),
    },
  });
}

function acknowledge(incidentId: string, token?: string) {
  const req = request(app)
    .post(`/api/v1/incidents/${incidentId}/acknowledge`);

  return token === undefined
    ? req.send({})
    : req.send({ token });
}

describe("Incident acknowledgement", () => {
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL must point to signal_test before running integration tests.",
      );
    }

    if (new URL(databaseUrl).pathname !== "/signal_test") {
      throw new Error(
        "Safety check failed: tests may only use the signal_test database.",
      );
    }

    serviceName = `signal-ack-test-${Date.now()}`;

    const service = await prisma.service.create({
      data: { name: serviceName },
    });

    serviceId = service.id;

    const user = await prisma.user.create({
      data: {
        name: "ACK Test User",
        notificationTarget: "ack-test@example.com",
      },
    });

    userId = user.id;
  });

  afterAll(async () => {
    try {
      if (serviceId!) {
        await prisma.incident.deleteMany({
          where: { serviceId },
        });

        await prisma.service.delete({
          where: { id: serviceId },
        });
      }

      if (userId!) {
        await prisma.user.delete({
          where: { id: userId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it("acknowledges a firing incident and records one event", async () => {
    const incident = await createIncident();
    const token = createAckToken(incident.id, userId);

    const response = await acknowledge(incident.id, token);

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe("acknowledged");

    const updated = await prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
    });

    expect(updated.status).toBe("ACKNOWLEDGED");
    expect(updated.acknowledgedById).toBe(userId);
    expect(updated.acknowledgedAt).not.toBeNull();
    expect(updated.nextActionAt).toBeNull();

    const events = await prisma.incidentEvent.count({
      where: {
        incidentId: incident.id,
        type: "INCIDENT_ACKNOWLEDGED",
      },
    });

    expect(events).toBe(1);
  });

  it("rejects a missing token", async () => {
    const incident = await createIncident();

    const response = await acknowledge(incident.id);

    expect(response.status).toBe(400);

    const unchanged = await prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
    });

    expect(unchanged.status).toBe("FIRING");
  });

  it("rejects an invalid token", async () => {
    const incident = await createIncident();

    const response = await acknowledge(incident.id, "invalid.token");

    expect(response.status).toBe(401);
  });

  it("rejects a correctly signed but expired token", async () => {
    const incident = await createIncident();
    const token = expiredAckToken(incident.id, userId);

    const response = await acknowledge(incident.id, token);

    expect(response.status).toBe(401);
  });

  it("rejects a token issued for a different incident", async () => {
    const incident = await createIncident();
    const token = createAckToken("another-incident-id", userId);

    const response = await acknowledge(incident.id, token);

    expect(response.status).toBe(401);
  });

  it("returns 404 when the incident does not exist", async () => {
    const missingId = "missing-incident-id";
    const token = createAckToken(missingId, userId);

    const response = await acknowledge(missingId, token);

    expect(response.status).toBe(404);
  });

  it("rejects acknowledgement of a resolved incident", async () => {
    const incident = await createIncident("RESOLVED");
    const token = createAckToken(incident.id, userId);

    const response = await acknowledge(incident.id, token);

    expect(response.status).toBe(409);

    const unchanged = await prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
    });

    expect(unchanged.status).toBe("RESOLVED");
  });

  it("rejects a token referring to a nonexistent user", async () => {
    const incident = await createIncident();
    const token = createAckToken(
      incident.id,
      "nonexistent-test-user",
    );

    const response = await acknowledge(incident.id, token);

    expect(response.status).toBe(401);

    const unchanged = await prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
    });

    expect(unchanged.status).toBe("FIRING");

    const eventCount = await prisma.incidentEvent.count({
      where: { incidentId: incident.id },
    });

    expect(eventCount).toBe(0);
  });

  it("does not create a duplicate event for a repeated ACK", async () => {
    const incident = await createIncident();
    const token = createAckToken(incident.id, userId);

    const first = await acknowledge(incident.id, token);
    const second = await acknowledge(incident.id, token);

    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("acknowledged");

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("already_acknowledged");

    const eventCount = await prisma.incidentEvent.count({
      where: {
        incidentId: incident.id,
        type: "INCIDENT_ACKNOWLEDGED",
      },
    });

    expect(eventCount).toBe(1);
  });
});
