import { NextResponse, type NextRequest } from "next/server";

/** Per-request Content Security Policy.
 *
 * Set here rather than in nginx because the policy needs a fresh nonce on
 * every response and Next has to know it to stamp its own inline scripts.
 * nginx's server-level policy (`script-src 'self'`) blocked those outright,
 * along with this app's theme bootstrap, and the result was not a degraded
 * page but a blank one.
 *
 * The directives beyond the defaults are all load-bearing here:
 *
 *   worker-src blob:  livekit-client builds the frame-cryptor worker from a
 *                     blob URL. Without it the worker throws, the call engine
 *                     falls back to `worker = null`, and the call proceeds
 *                     **unencrypted** with nothing in the UI saying so.
 *   img-src data:     inline thumbnails and link-preview images.
 *   img-src blob:     decrypted photos and avatars.
 *   media-src blob:   decrypted video and voice notes.
 *   connect-src wss:  the delivery WebSocket and LiveKit signaling.
 *
 * `'strict-dynamic'` lets Next's nonced bootstrap load the chunks it needs
 * without listing every one.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    `default-src 'self'`,
    // 'unsafe-eval' in development only: React uses eval to rebuild
    // server-side error stacks in the browser. Production needs neither.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Next and the CSS modules emit style attributes that cannot carry a
    // nonce, and a style injection is not a script execution.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `media-src 'self' blob:`,
    `worker-src 'self' blob:`,
    `font-src 'self'`,
    `connect-src 'self' ws: wss:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except Next's own static output and the icons, which are
    // plain files that never carry an inline script and would only churn a
    // nonce for nothing.
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
