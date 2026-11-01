#!/usr/bin/env node
import crypto from "crypto";

const emailArg = process.argv[2];
const passArg = process.argv[3];

if (!emailArg || !passArg) {
  console.log("Usage: npm run hash-admin <admin-email> <admin-password>");
  console.log('Example: npm run hash-admin "myemail@gmail.com" "MySuperStrongPass#99"');
  process.exit(1);
}

const salt = crypto.randomBytes(20).toString("hex");
const emailHash = crypto
  .pbkdf2Sync(emailArg.trim().toLowerCase(), salt + ":email", 100000, 64, "sha512")
  .toString("hex");
const passHash = crypto
  .pbkdf2Sync(passArg, salt + ":pass", 100000, 64, "sha512")
  .toString("hex");

console.log("\n=== COPY THESE TO VERCEL ENVIRONMENT VARIABLES (OR .env.local) ===");
console.log(`ADMIN_SALT=${salt}`);
console.log(`ADMIN_EMAIL_HASH=${emailHash}`);
console.log(`ADMIN_PASSWORD_HASH=${passHash}`);
console.log(`ADMIN_SESSION_SECRET=${crypto.randomBytes(32).toString("hex")}`);
console.log("==================================================================\n");
