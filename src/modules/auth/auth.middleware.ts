import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";
import { prisma } from "../../db/prisma.js";
import {
  accessCookieName,
  jwtAudience,
  jwtIssuer,
  jwtKey,
} from "./auth.config.js";

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;

    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }

  return undefined;
}

export async function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const token = readCookie(request, accessCookieName);
  if (!token) {
    response.status(401).json({ error: "UNAUTHENTICATED" });
    return;
  }

  let userId: string;
  let authVersion: number;

  try {
    const { payload } = await jwtVerify(token, jwtKey, {
      algorithms: ["HS256"],
      issuer: jwtIssuer,
      audience: jwtAudience,
    });

    if (
      typeof payload.sub !== "string" ||
      typeof payload.authVersion !== "number" ||
      !Number.isInteger(payload.authVersion)
    ) {
      response.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }

    userId = payload.sub;
    authVersion = payload.authVersion;
  } catch {
    response.status(401).json({ error: "UNAUTHENTICATED" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, authVersion: true, role: true },
    });

    if (!user || user.role !== "CUSTOMER" || user.authVersion !== authVersion) {
      response.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }

    response.locals.authenticatedUser = { id: user.id, email: user.email };
    next();
  } catch (error) {
    next(error);
  }
}
