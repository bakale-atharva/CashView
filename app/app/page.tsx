import { auth } from "@clerk/nextjs/server";

// Placeholder so the /app gate can be exercised; replaced by the shell in F1.
export default async function AppHome() {
  // Redirects to the sign-in route when signed out. Check per page, not in a
  // layout: layouts don't re-render on client navigation between pages.
  await auth.protect();

  return (
    <main className="flex flex-1 items-center justify-center">
      <p className="text-muted-foreground">Signed in.</p>
    </main>
  );
}
