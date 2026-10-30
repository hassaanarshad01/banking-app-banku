import type { Response } from "express";
import { accessCookieName, isProduction } from "./auth.config.js";

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "strict" as const,
  path: "/",
};

export function setAccessCookie(response: Response, token: string) {
  response.cookie(accessCookieName, token, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000,
  });
}

export function clearAccessCookie(response: Response) {
  response.clearCookie(accessCookieName, cookieOptions);
}
