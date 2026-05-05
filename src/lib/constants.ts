// ── Cookie names ─────────────────────────────────────────
export const SESSION_COOKIE = 'ng_session';

// ── Nepal Provinces ───────────────────────────────────────
export const NEPAL_PROVINCES = [
  { id: 1, name: 'Koshi Province'     },
  { id: 2, name: 'Madhesh Province'   },
  { id: 3, name: 'Bagmati Province'   },
  { id: 4, name: 'Gandaki Province'   },
  { id: 5, name: 'Lumbini Province'   },
  { id: 6, name: 'Karnali Province'   },
  { id: 7, name: 'Sudurpashchim Province' },
] as const;

// ── Gig Categories ────────────────────────────────────────
export const GIG_CATEGORIES = [
  { id: 'web_dev',       label: 'Web Development'        },
  { id: 'mobile_dev',    label: 'Mobile Development'     },
  { id: 'design',        label: 'Design & Creative'      },
  { id: 'writing',       label: 'Writing & Translation'  },
  { id: 'marketing',     label: 'Digital Marketing'      },
  { id: 'video',         label: 'Video & Animation'      },
  { id: 'data',          label: 'Data & Analytics'       },
  { id: 'accounting',    label: 'Accounting & Finance'   },
  { id: 'legal',         label: 'Legal & Compliance'     },
  { id: 'it_support',    label: 'IT & Networking'        },
  { id: 'teaching',      label: 'Online Tutoring'        },
  { id: 'photography',   label: 'Photography'            },
  { id: 'other',         label: 'Other'                  },
] as const;

// ── Platform Fees ─────────────────────────────────────────
export const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT ?? 5);

// ── Budget limits (paisa = NPR × 100) ────────────────────
export const MIN_GIG_BUDGET_PAISA  = 100_00;   // NPR 100
export const MAX_GIG_BUDGET_PAISA  = 10_000_00_00; // NPR 10 lakh

// ── User limits ───────────────────────────────────────────
export const MAX_ACTIVE_PROPOSALS_PER_FREELANCER = 10;
export const MAX_ACTIVE_GIGS_PER_CLIENT          = 5;

// ── Roles ─────────────────────────────────────────────────
export type UserRole = 'pending' | 'freelancer' | 'client' | 'admin';
