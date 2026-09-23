import { auth } from "@clerk/nextjs/server";
import { BrandingForm } from "@/components/settings/branding-form";

export default async function BrandingSettingsPage() {
  await auth.protect();
  return <BrandingForm />;
}
