const jwtSecretText = process.env.JWT_ACCESS_SECRET;

if (!jwtSecretText || Buffer.byteLength(jwtSecretText, "utf8") < 32) {
  throw new Error("JWT_ACCESS_SECRET must be set to at least 32 random bytes");
}

export const jwtKey = new TextEncoder().encode(jwtSecretText);
export const jwtIssuer = "banku-api";
export const jwtAudience = "banku-web";
export const accessCookieName = "banku_access";
export const isProduction = process.env.NODE_ENV === "production";
