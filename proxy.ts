import { clerkMiddleware } from "@clerk/nextjs/server";

// Deliberately does not gate any route. Clerk deprecated createRouteMatcher()
// because path-based gating here can be bypassed (Server Actions are called by
// id, not path) and gives a false sense of security. This only makes auth
// state available to `auth()`; each protected page, Route Handler and Server
// Action must call `await auth.protect()` itself. Convex enforces access
// again on its side.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
