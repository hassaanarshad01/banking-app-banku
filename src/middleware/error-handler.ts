import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  // Keep the details in the server log, not in a response sent to the browser.
  console.error(error);
  response.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
