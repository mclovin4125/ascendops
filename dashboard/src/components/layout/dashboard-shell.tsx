'use client';

import { useState, useEffect } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { BottomNav } from './bottom-nav';
import { OrgContext } from '@/hooks/use-org';
import {
  Sheet,
  SheetContent,
} from '@/components/ui/sheet';

interface DashboardShellProps {
  orgs: string[];
  brandName?: string;
  /** Org resolved from the cookie on the server. Used as the initial value so
   *  the first client render matches the server HTML (no hydration mismatch). */
  initialOrg?: string;
  children: React.ReactNode;
}

const ORG_COOKIE = 'cortextos-org';

export function DashboardShell({ orgs, brandName, initialOrg = 'all', children }: DashboardShellProps) {
  // Deterministic on server and client: both start from the cookie-derived
  // prop. Reading localStorage/URL here would diverge from the server and
  // break hydration — those are reconciled in effects after mount instead.
  const [currentOrg, setCurrentOrg] = useState<string>(initialOrg);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Reconcile the org after mount, where reading the URL/localStorage can't
  // cause a hydration mismatch. Priority: ?org= deep link > cookie (already
  // applied via initialOrg) > last localStorage selection. The localStorage
  // fallback also migrates returning users who have no cookie yet — adopting
  // it here seeds the cookie via the persistence effect below.
  useEffect(() => {
    const isValid = (o: string) => o === 'all' || orgs.includes(o);
    const urlOrg = new URLSearchParams(window.location.search).get('org');
    if (urlOrg && isValid(urlOrg)) {
      if (urlOrg !== currentOrg) setCurrentOrg(urlOrg);
      return;
    }
    if (initialOrg === 'all') {
      const saved = localStorage.getItem(ORG_COOKIE);
      if (saved && isValid(saved) && saved !== currentOrg) setCurrentOrg(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist org selection to localStorage and to a cookie the server layout
  // reads on the next request so its first paint matches the client.
  useEffect(() => {
    localStorage.setItem(ORG_COOKIE, currentOrg);
    document.cookie = `${ORG_COOKIE}=${encodeURIComponent(currentOrg)}; path=/; max-age=31536000; samesite=lax`;
  }, [currentOrg]);

  return (
    <OrgContext.Provider value={{ currentOrg, setCurrentOrg, orgs }}>
      <div className="flex h-screen">
        {/* Desktop sidebar */}
        <div className="hidden md:block">
          <Sidebar brandName={brandName} onNavigate={() => {}} />
        </div>

        {/* Mobile sidebar sheet */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-60 p-0" showCloseButton={false}>
            <Sidebar brandName={brandName} onNavigate={() => setSidebarOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar
            orgs={orgs}
            currentOrg={currentOrg}
            onOrgChange={setCurrentOrg}
            onMenuClick={() => setSidebarOpen(true)}
          />
          <main className="flex-1 overflow-auto p-4 pb-20 md:pb-5 md:p-5 lg:p-6 bg-background">
            {children}
          </main>

          {/* Mobile bottom navigation */}
          <BottomNav />
        </div>
      </div>
    </OrgContext.Provider>
  );
}
