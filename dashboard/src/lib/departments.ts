// Department layer for the cockpit. Maps a human department to the agent that
// runs it (by systemName / filesystem key). Plain data — no React imports — so
// it is safe to consume from both server components and the client sidebar.
//
// The `agent` field ships EMPTY by default: each org fills in which of its own
// agents runs each department. The department view renders an empty agent as a
// "not yet stood up / to build" config-prompt, so the dashboard is usable before
// any agents are assigned. (A build-time codegen from the org roster is a planned
// follow-up so this can auto-populate from the members' actual roster.)

export interface Department {
  /** URL slug: /departments/<slug> */
  slug: string;
  /** Display label */
  label: string;
  /** The agent's systemName (filesystem key) that runs this department */
  agent: string;
  /** One-line description of what this department covers */
  blurb: string;
}

export const DEPARTMENTS: Department[] = [
  { slug: 'operations',  label: 'Operations',  agent: 'ea',                  blurb: 'Orchestration, scheduling, and fleet coordination' },
  { slug: 'maintenance', label: 'Maintenance', agent: 'maintenance-director', blurb: 'Work orders, vendor dispatch, and turnovers' },
  { slug: 'leasing',     label: 'Leasing',     agent: '',                    blurb: 'Renewals, applicant screening, and showings' },
  { slug: 'analytics',   label: 'Analytics',   agent: 'analyst',             blurb: 'Reporting, KPIs, and portfolio insight' },
  { slug: 'dev',         label: 'Dev',         agent: 'dev',                 blurb: 'Integrations, automation, and the technical stack' },
  { slug: 'accounting',  label: 'Accounting',  agent: '',                    blurb: 'AR/AP, owner draws, and trust reconciliation' },
];

export function getDepartment(slug: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.slug === slug);
}

export function departmentForAgent(agent: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.agent === agent);
}
