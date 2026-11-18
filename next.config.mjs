/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["telegram", "firebase-admin"],
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
  async headers() {
    // 🔒 CORS FIX (v5): pehle yahan `Access-Control-Allow-Origin: *` aur
    // `Access-Control-Allow-Credentials: true` ek saath tha — ye combination
    // CORS spec ke hisaab se invalid hai (browser ignore kar deta hai) aur
    // saare /api routes ko duniya bhar ke liye wildcard par khol deta tha.
    //
    // Ab `Access-Control-Allow-Origin` per-request DYNAMICALLY set hota hai
    // (src/lib/httpGuards.ts → streamCorsHeaders): sirf allowlisted origin
    // (apna domain, Cloudflare worker, *.vercel.app preview, localhost) reflect
    // hota hai. Yahan sirf methods/headers/expose declarations hain.
    return [
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Access-Control-Allow-Methods",
            value: "GET,HEAD,DELETE,PATCH,POST,PUT,OPTIONS",
          },
          {
            key: "Access-Control-Allow-Headers",
            value:
              "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, Range, X-Worker-Secret, X-SHD-Client, X-SHD-Worker-Proxy",
          },
          {
            key: "Access-Control-Expose-Headers",
            value:
              "Content-Range, Accept-Ranges, Content-Length, Content-Type, X-SHD-Total-Size, X-SHD-File-Name, X-SHD-Mime-Type, X-SHD-Engine, X-SHD-Edge-Cache",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
