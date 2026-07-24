import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getOrgs, getBrandName } from '@/lib/config';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { syncAll } from '@/lib/sync';

// Cookie that mirrors the client-side org selection. Read here so the server
// renders the same initial org as the client, avoiding a hydration mismatch
// in the sidebar/org-selector (App Router layouts can't read ?org= from the
// URL, so the cookie is the shared source of truth for the first paint).
const ORG_COOKIE = 'cortextos-org';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect('/login');

  // Sync filesystem state to SQLite on every page load
  // This ensures the dashboard always reflects the latest agent activity
  try {
    syncAll();
  } catch (e) {
    console.error('Sync failed:', e);
  }

  const orgs = getOrgs();
  const brandName = getBrandName();

  // Resolve the initial org from the cookie, validated against known orgs so a
  // stale/removed org can never be rendered. Defaults to 'all'.
  const cookieOrg = (await cookies()).get(ORG_COOKIE)?.value;
  const initialOrg =
    cookieOrg && (cookieOrg === 'all' || orgs.includes(cookieOrg)) ? cookieOrg : 'all';

  return (
    <DashboardShell orgs={orgs} brandName={brandName} initialOrg={initialOrg}>
      {children}
    </DashboardShell>
  );
}
