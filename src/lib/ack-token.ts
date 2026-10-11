
import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

type AckTokenPayload = {
  incidentId: string;
  userId: string;
  action: "acknowledge";
  exp: number;
};

const TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

function getSecret(): string {
  const secret = process.env.ACK_TOKEN_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "ACK_TOKEN_SECRET must contain at least 32 characters",
    );
  }

  return secret;
}

function sign(value: string): Buffer {
  return createHmac("sha256", getSecret())
    .update(value)
    .digest();
}

export function createAckToken(
  incidentId: string,
  userId: string,
): string {
  const payload: AckTokenPayload = {
    incidentId,
    userId,
    action: "acknowledge",
    exp:
      Math.floor(Date.now() / 1000) +
      TOKEN_LIFETIME_SECONDS,
  };

  const encodedPayload = Buffer
    .from(JSON.stringify(payload))
    .toString("base64url");

  const signature = sign(encodedPayload)
    .toString("base64url");

  return `${encodedPayload}.${signature}`;
}

export function verifyAckToken(
  token: string,
): AckTokenPayload | null {
  try {
    const parts = token.split(".");

    if (parts.length !== 2) {
      return null;
    }

    const [encodedPayload, encodedSignature] = parts;

    if (!encodedPayload || !encodedSignature) {
      return null;
    }

    const expectedSignature = sign(encodedPayload);
    const receivedSignature = Buffer.from(
      encodedSignature,
      "base64url",
    );

    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(
        receivedSignature,
        expectedSignature,
      )
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as AckTokenPayload;

    if (
      typeof payload.incidentId !== "string" ||
      !payload.incidentId ||
      typeof payload.userId !== "string" ||
      !payload.userId ||
      payload.action !== "acknowledge" ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
