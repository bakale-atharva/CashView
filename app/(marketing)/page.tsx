import { Show, SignInButton, SignUpButton } from "@clerk/nextjs";
import Link from "next/link";
import { InvoiceStampDemo } from "@/components/marketing/invoice-stamp-demo";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "",
    features: [
      "5 clients",
      "10 invoices / month",
      "Unlimited expenses",
      "PDF invoices & public share links",
    ],
  },
  {
    name: "Pro",
    price: "$19",
    period: "/mo",
    features: [
      "Unlimited clients & invoices",
      "5 team seats",
      "Recurring invoices",
      "Financial reports",
    ],
    featured: true,
  },
  {
    name: "Business",
    price: "$49",
    period: "/mo",
    features: [
      "20 team seats",
      "Everything in Pro",
      "AI receipt scanning",
      "Multi-currency invoicing",
    ],
  },
];

const features = [
  {
    title: "Send a link, not an email thread",
    body: "Marking an invoice Sent mints an unguessable public link. Your client opens it, sees exactly that invoice, and can pay — no account, no inbox back-and-forth.",
  },
  {
    title: "A photo turns into an expense",
    body: "Business-tier receipt scanning reads the vendor, date, total, tax and category off a photo and hands you a pre-filled expense to confirm. Nothing saves without your approval.",
  },
  {
    title: "Reports that trust their own numbers",
    body: "Revenue, outstanding vs. collected, profit and loss, cash flow — computed server-side from the same records every invoice and payment already updated.",
  },
  {
    title: "Four roles, one set of books",
    body: "Owner, Admin, Accountant, Viewer. A bookkeeper gets exactly the access their role allows — enforced on the server, not just hidden in the interface.",
  },
];

export default function MarketingHome() {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero — the mechanism, demonstrated */}
      <section className="mx-auto flex w-full max-w-6xl flex-col items-center gap-14 px-6 pb-20 pt-14 lg:flex-row lg:items-center lg:gap-10 lg:pt-24">
        <div className="flex max-w-xl flex-col items-start gap-6">
          <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            Your books, kept the way a bookkeeper actually keeps them.
          </h1>
          <p className="text-lg leading-relaxed text-muted-foreground">
            CashView is invoicing, expenses, clients and reporting for a small
            business or a freelancer — with a personal workspace and an
            organization workspace that are both first-class, never one
            bolted onto the other.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Show when="signed-out">
              <SignUpButton>
                <Button size="lg">Start free</Button>
              </SignUpButton>
              <SignInButton>
                <Button size="lg" variant="outline">
                  Sign in
                </Button>
              </SignInButton>
            </Show>
            <Show when="signed-in">
              <Button size="lg" render={<Link href="/app" />}>
                Go to your books
              </Button>
            </Show>
          </div>
          <p className="text-sm text-muted-foreground">
            Free for up to 5 clients and 10 invoices a month. No card required.
          </p>
        </div>
        <div className="flex w-full max-w-md items-center justify-center lg:flex-1">
          <InvoiceStampDemo />
        </div>
      </section>

      {/* Scope duality — the architectural differentiator, stated plainly */}
      <section className="border-y border-border bg-secondary/40">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-16">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Two kinds of books. Same discipline. Never mixed.
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-sm font-semibold">Personal account</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Your own invoicing and expenses, from day one — not a
                stripped-down preview of the &ldquo;real&rdquo; product.
                Upgrade it on its own plan whenever you&rsquo;re ready.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-5">
              <p className="text-sm font-semibold">Organization</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Invite an accountant or a bookkeeper with a real role — Owner,
                Admin, Accountant or Viewer — on a shared subscription that
                covers the whole team.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features — asymmetric, not a grid of identical icon cards */}
      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="grid gap-x-10 gap-y-14 sm:grid-cols-2">
          {features.map((feature, i) => (
            <div
              key={feature.title}
              className={i % 2 === 1 ? "sm:mt-10" : undefined}
            >
              <h3 className="text-lg font-semibold tracking-tight">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing teaser — real numbers, no invented claims */}
      <section className="border-t border-border bg-secondary/40 py-20">
        <div className="mx-auto w-full max-w-6xl px-6">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Free to start. Priced for one person or a whole team.
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Every plan comes in an organization and a personal version — your
            personal workspace and any organization you join are billed and
            upgraded independently.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={
                  "flex flex-col rounded-xl border p-6 " +
                  (plan.featured
                    ? "border-primary bg-card shadow-[0_1px_0_var(--border)]"
                    : "border-border bg-card")
                }
              >
                <p className="text-sm font-semibold text-muted-foreground">
                  {plan.name}
                </p>
                <p className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold tracking-tight">
                    {plan.price}
                  </span>
                  {plan.period && (
                    <span className="text-sm text-muted-foreground">
                      {plan.period}
                    </span>
                  )}
                </p>
                <ul className="mt-5 space-y-2 text-sm text-foreground/80">
                  {plan.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-6 py-24 text-center">
        <h2 className="max-w-lg text-2xl font-semibold tracking-tight sm:text-3xl">
          Open your books in a couple of minutes.
        </h2>
        <Show when="signed-out">
          <SignUpButton>
            <Button size="lg">Start free</Button>
          </SignUpButton>
        </Show>
        <Show when="signed-in">
          <Button size="lg" render={<Link href="/app" />}>
            Go to your books
          </Button>
        </Show>
      </section>

      <footer className="border-t border-border px-6 py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
          <Logo markClassName="text-muted-foreground" className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} CashView.
          </p>
        </div>
      </footer>
    </main>
  );
}
