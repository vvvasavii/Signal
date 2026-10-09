
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { hashApiKey } from "../lib/api-key.js";

export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Missing or invalid API key",
    });
  }

  const key = authorization.slice("Bearer ".length).trim();

  if (!key) {
    return res.status(401).json({
      error: "Missing or invalid API key",
    });
  }

  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: {
        keyHash: hashApiKey(key),
      },
      select: {
        id: true,
        serviceId: true,
        revokedAt: true,
      },
    });

    if (!apiKey || apiKey.revokedAt !== null) {
      return res.status(401).json({
        error: "Invalid or revoked API key",
      });
    }

    res.locals.serviceId = apiKey.serviceId; // Store the serviceId in res.locals for use in subsequent middleware or route handlers
    res.locals.apiKeyId = apiKey.id; //.locals is an object that is available to all middleware and route handlers in the request-response cycle. By storing the serviceId and apiKeyId in res.locals, you can access them later in your route handlers without having to query the database again.

    return next();
  } catch (error) {
    console.error("API-key authentication failed:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
