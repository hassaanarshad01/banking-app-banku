import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Keep one client and one connection pool for this Node process.
const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });
