/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server with only the files it actually needs, so
  // the runtime image carries no node_modules tree and no build toolchain.
  output: "standalone",
  // `next dev` only accepts its own origin by default, and the client never
  // hydrates on any other. Testing two members at once needs two origins,
  // since one origin means one localStorage and therefore one device identity.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // In production nginx owns these prefixes; `next dev` has no nginx in front
  // of it, so it proxies them itself to keep the client same-origin either way.
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    const auth = process.env.DEV_AUTH_ORIGIN ?? "http://127.0.0.1:8080";
    const messaging = process.env.DEV_MSG_ORIGIN ?? "http://127.0.0.1:8090";
    return [
      { source: "/auth/:path*", destination: `${auth}/:path*` },
      { source: "/msg/:path*", destination: `${messaging}/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Insertable Streams run in a worker livekit-client creates from a
          // blob URL; without these the SFrame transform silently never loads.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
