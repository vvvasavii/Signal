
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  EscalationState,
  IncidentStatus,
  Severity,
} from "../src/generated/prisma/client.js";
import { prisma } from "../src/lib/prisma.js";
import { claimInitialEscalation } from "../src/services/escalation-scheduler.js";

describe("Initial escalation scheduler", () => {
  let serviceId: string;

  beforeAll(async () => {
    // Safety guard: never run these integration tests against
    // the development database.
    const databaseUrl = process.env.DATABASE_URL;

    if (
      !databaseUrl ||
      new URL(databaseUrl).pathname !== "/signal_test"
    ) {
      throw new Error(
        "Tests must use the signal_test database.",
      );
    }

    // Create an isolated service for this test suite.
    const service = await prisma.service.create({
      data: {
        name: `scheduler-test-${crypto.randomUUID()}`,
      },
    });

    serviceId = service.id;
  });

  afterAll(async () => {
    // Clean up test data so repeated runs don't leave records behind.
    if (serviceId) {
      await prisma.incident.deleteMany({
        where: { serviceId },
      });

      await prisma.service.delete({
        where: { id: serviceId },
      });
    }

    // Close Prisma's database connections after the suite finishes.
    await prisma.$disconnect();
  });

  // Helper: create a fresh incident for each test.
  // By default, it is FIRING and already due for escalation.
  async function createIncident(
    overrides: {
      status?: IncidentStatus;
      nextActionAt?: Date | null;
    } = {},
  ) {
    return prisma.incident.create({
      data: {
        serviceId,
        environment: "test",
        dedupKey: crypto.randomUUID(),
        severity: Severity.WARNING,
        status: overrides.status ?? IncidentStatus.FIRING,
        nextActionAt:
          overrides.nextActionAt ?? new Date(Date.now() - 1000),
        escalationState: EscalationState.ACTIVE,
        // Minimal snapshot containing the required initial step.
        policySnapshot: {
          steps: [{ stepIndex: 0 }],
        },
      },
    });
  }

  it("claims step 0 and clears nextActionAt", async () => {
    // Arrange: create an eligible incident.
    const incident = await createIncident();

    // Act: attempt to claim its initial escalation.
    const result = await claimInitialEscalation(incident.id);

    // Assert: the claim succeeds.
    expect(result.outcome).toBe("claimed");

    if (result.outcome !== "claimed") return;

    // Read the persisted state, including related records.
    const updated = await prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
      include: {
        escalationAttempts: {
          include: { notificationAttempt: true },
        },
        events: true,
      },
    });

    // The consumed deadline is cleared.
    expect(updated.nextActionAt).toBeNull();

    // Exactly one initial escalation attempt exists.
    expect(updated.escalationAttempts).toHaveLength(1);
    expect(updated.escalationAttempts[0].stepIndex).toBe(0);

    // The notification belongs to the attempt returned by the claim.
    expect(
      updated.escalationAttempts[0].notificationAttempt?.id,
    ).toBe(result.notificationAttemptId);

    // The scheduler records an audit event.
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].type).toBe(
      "ESCALATION_SCHEDULED",
    );
  });

  it("does not claim the same due timestamp twice", async () => {
    const incident = await createIncident();

    // First call consumes the due timestamp.
    const first = await claimInitialEscalation(incident.id);

    // Second call should find that the incident is no longer due.
    const second = await claimInitialEscalation(incident.id);

    expect(first.outcome).toBe("claimed");
    expect(second.outcome).toBe("not_due");

    // Verify that repeating the call didn't create another attempt.
    const attempts = await prisma.escalationAttempt.count({
      where: { incidentId: incident.id },
    });

    expect(attempts).toBe(1);
  });

  it("does not claim an acknowledged incident", async () => {
    // ACKNOWLEDGED incidents must not start a new escalation.
    const incident = await createIncident({
      status: IncidentStatus.ACKNOWLEDGED,
    });

    const result = await claimInitialEscalation(incident.id);

    expect(result.outcome).toBe("inactive");

    // No escalation attempt should have been created.
    const attempts = await prisma.escalationAttempt.count({
      where: { incidentId: incident.id },
    });

    expect(attempts).toBe(0);
  });

  it("does not claim an incident that is not due", async () => {
    // Set the deadline in the future.
    const incident = await createIncident({
      nextActionAt: new Date(Date.now() + 60_000),
    });

    const result = await claimInitialEscalation(incident.id);

    expect(result.outcome).toBe("not_due");

    // A future deadline must not create an attempt prematurely.
    const attempts = await prisma.escalationAttempt.count({
      where: { incidentId: incident.id },
    });

    expect(attempts).toBe(0);
  });
});
