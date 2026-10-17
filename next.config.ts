import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/invoices/**": ["./assets/**"],
  },
  serverExternalPackages: ["nodemailer"],
};

export default nextConfig;
