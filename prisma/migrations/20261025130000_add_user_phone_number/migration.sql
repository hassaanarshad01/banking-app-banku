ALTER TABLE "users" ADD COLUMN "phone_number" VARCHAR(64);

CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");
