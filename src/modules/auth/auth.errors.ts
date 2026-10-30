export type AuthErrorCode =
  | "EMAIL_ALREADY_REGISTERED"
  | "PHONE_ALREADY_REGISTERED"
  | "INVALID_CREDENTIALS"
  | "INVALID_REQUEST"
  | "BONUS_UNAVAILABLE";

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
  }
}
