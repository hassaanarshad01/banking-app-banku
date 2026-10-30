import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "./auth.middleware.js";
import {
  currentUserController,
  loginController,
  logoutController,
  signupController,
  updateProfileController,
} from "./auth.controller.js";

const router = Router();

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "TOO_MANY_ATTEMPTS" },
});

router.post("/signup", authRateLimit, signupController);
router.post("/login", authRateLimit, loginController);
router.get("/me", requireAuth, currentUserController);
router.patch("/profile", requireAuth, authRateLimit, updateProfileController);
router.post("/logout", requireAuth, logoutController);

export { router as authRoutes };
