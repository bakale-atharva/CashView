import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

// The marketing page and the sign-in/sign-up pages share this simple header.
// The authenticated app has its own shell (app/app/layout.tsx) and does not
// render this — see the (marketing) route group boundary.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex h-16 items-center justify-end gap-4 px-6">
        <Show when="signed-out">
          <SignInButton />
          <SignUpButton />
        </Show>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>
      {children}
    </div>
  );
}
