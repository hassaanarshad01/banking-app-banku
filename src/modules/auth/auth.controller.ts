import type { RequestHandler } from "express";
import { AuthError } from "./auth.errors.js";
import { clearAccessCookie, setAccessCookie } from "./auth.cookie.js";
import { loginSchema, signupSchema, updateProfileSchema } from "./auth.schemas.js";
import { currentUser, login, logoutAllSessions, signup, updateProfile } from "./auth.service.js";

export const signupController: RequestHandler = async (request, response, next) => {
  const parsed = signupSchema.safeParse(request.body);
  if (!parsed.success) {
    const underage = parsed.error.issues.some((issue) => issue.message === "UNDER_18");
    response.status(400).json({ error: underage ? "UNDER_18" : "INVALID_REQUEST" });
    return;
  }

  try {
    const result = await signup(
      parsed.data.email,
      parsed.data.password,
      parsed.data.dateOfBirth,
      parsed.data.fullName,
      parsed.data.phoneNumber,
    );
    setAccessCookie(response, result.accessToken);
    response.status(201).json({ user: result.user });
  } catch (error) {
    if (error instanceof AuthError) {
      const status = error.code === "EMAIL_ALREADY_REGISTERED" || error.code === "PHONE_ALREADY_REGISTERED"
        ? 409
        : error.code === "BONUS_UNAVAILABLE" ? 503 : 400;
      response.status(status)
        .json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const loginController: RequestHandler = async (request, response, next) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }

  try {
    const result = await login(parsed.data.email, parsed.data.password);
    setAccessCookie(response, result.accessToken);
    response.status(200).json({ user: result.user });
  } catch (error) {
    if (error instanceof AuthError) {
      response.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }
    next(error);
  }
};

export const currentUserController: RequestHandler = async (_request, response, next) => {
  try {
    const user = await currentUser(response.locals.authenticatedUser.id);
    response.json({ user });
  } catch (error) {
    next(error);
  }
};

export const updateProfileController: RequestHandler = async (request, response, next) => {
  const parsed = updateProfileSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  try {
    const user = await updateProfile(response.locals.authenticatedUser.id, parsed.data);
    response.json({ user });
  } catch (error) {
    if (error instanceof AuthError) {
      const status = error.code === "EMAIL_ALREADY_REGISTERED" || error.code === "PHONE_ALREADY_REGISTERED" ? 409 : 401;
      response.status(status).json({ error: error.code });
      return;
    }
    next(error);
  }
};

export const logoutController: RequestHandler = async (_request, response, next) => {
  try {
    await logoutAllSessions(response.locals.authenticatedUser.id);
    clearAccessCookie(response);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
};
