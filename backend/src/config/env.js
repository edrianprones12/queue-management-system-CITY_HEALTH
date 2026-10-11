const path = require("path");
const dotenv = require("dotenv");

// The backend may be started from the repository root or the backend folder.
// Always load this service's configuration instead of the caller's directory.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const env = {
  port: Number(process.env.PORT || 4000),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  smsSenderName: process.env.SMS_SENDER_NAME || "Smart Queuing System",
  smsGatewayAddress: process.env.SMS_GATEWAY_ADDRESS || "",
  gatewayApiToken: (process.env.GATEWAY_API_TOKEN || "").trim(),
  jwtSecret: process.env.JWT_SECRET || "default_secret"
};

module.exports = env;
