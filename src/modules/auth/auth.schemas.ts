import { z } from "zod";

const email = z.string().trim().email().max(254);

function parseDateOfBirth(value: string): [number, number, number] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parts = value.split("-").map(Number);
  const [year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return [year, month, day];
}

function isAdult(dateOfBirth: string): boolean {
  const parts = parseDateOfBirth(dateOfBirth);
  if (!parts) return false;
  const [year, month, day] = parts;
  const today = new Date();
  const currentMonth = today.getUTCMonth() + 1;
  const hasHadBirthday = currentMonth > month ||
    (currentMonth === month && today.getUTCDate() >= day);
  return today.getUTCFullYear() - year - (hasHadBirthday ? 0 : 1) >= 18;
}

const dateOfBirth = z.string().superRefine((value, context) => {
  if (!parseDateOfBirth(value)) {
    context.addIssue({ code: "custom", message: "INVALID_DATE" });
  } else if (!isAdult(value)) {
    context.addIssue({ code: "custom", message: "UNDER_18" });
  }
});

export const signupSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  phoneNumber: z.string().trim().min(1).max(64),
  email,
  password: z.string().min(12).max(128),
  dateOfBirth,
}).strict();

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
}).strict();

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email,
  phoneNumber: z.string().trim().max(64),
}).strict();
