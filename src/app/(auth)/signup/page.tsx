import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignupForm } from "@/features/auth/components/signup-form";
import { isSignupOpen } from "@/features/auth/services/signup-gate";

export const metadata: Metadata = {
  title: "Crear cuenta — Agente WhatsApp",
};

// The gate reads the DB (are there any users yet?), so it must be evaluated per
// request. Prerendering would freeze the answer at build time and make the
// build itself require the service-role key.
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  // Invite-only after bootstrap: once the admin account exists, no public signup.
  if (!(await isSignupOpen())) {
    redirect(
      "/login?message=El%20registro%20es%20solo%20por%20invitaci%C3%B3n",
    );
  }

  return <SignupForm />;
}
