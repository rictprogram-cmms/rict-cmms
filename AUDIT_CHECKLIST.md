# RICT CMMS — Audit Remediation Checklist

Audit performed against GitHub main `27b6f5b` (2026-08-24).
Check items off as they land on main. Add the changelog version next to each completed item.

Legend: **P1** = privacy/security · **P2** = accessibility (508 / WCAG 2.1 AA) · **P3** = house conventions · **P4** = code health

---

## P1 — Privacy & security

- [x] **Remove `create-users.mjs` from the repo and rewrite history** — done 2026-08-24 (`8e51988`); working copies re-cloned (`git filter-repo --path create-users.mjs --invert-paths`). File contained real names, emails and a shared temp password in a public repo.
  - [x] Confirm no accounts still use the temp password — only one never-signed-in account (already Archived); delete its auth user in Supabase → Authentication → Users
  - [x] Script no longer needed — users are created through the app. Delete outright.
  - [x] Add `*.local.*` and `seed/` to `.gitignore`. (delivered)
- [ ] **Implement `firstLastInitial()`** in `src/lib/utils.js` and apply on student-visible surfaces:
  - [ ] Asset checkouts (`AssetCheckoutsPage.jsx`, `useAssetCheckouts.js`)
  - [ ] Absence requests (`AbsenceRequestPage.jsx`)
  - [ ] Audit any other list a student can see that renders another student's full name (Lab Signup, Time Cards, Dashboard widgets)
- [ ] **Centralize super-admin exclusion.** `rictprogram@gmail.com` is hardcoded in 10+ files.
  - [ ] Add `SUPER_ADMIN_EMAIL` constant + `excludeSuperAdmin(rows)` helper in `src/lib/`
  - [ ] Replace inline `.neq('email', …)` / array filters (EmulationBar, AppLayout, useBugTracker, useSettings, useAbsenceRequests, usePermissions, AuthContext, ProgramPlannerPage, AbsenceRequestPage, AccessPage, LabStatusPage, AnnouncementsPage)
  - [ ] Server-side: `profiles_public` view or RLS predicate so the client can't forget
- [ ] **`xlsx` 0.18.5 — 5 high-severity advisories, no npm fix.** Options: install SheetJS from `cdn.sheetjs.com` tarball (0.20.x) or migrate exports to `exceljs`. Decide and implement.
- [ ] Strip `console.log` calls that print user emails/names (126 total `console.log`; audit for PII first, then remove or gate behind `import.meta.env.DEV`).

## P2 — Accessibility (Section 508 / WCAG 2.1 AA)

Do one page per session. Start with student-facing pages.

### App-wide
- [ ] Add skip-to-content link in `AppLayout.jsx` (target `<main id="main-content">`) — WCAG 2.4.1
- [ ] Build `LabeledField` / `LabeledSelect` helper using `useId()` so new forms are correct by default
- [ ] Replace `window.confirm` / `alert` (72 uses) with `ConfirmDialog` — also fixes kiosk behaviour
- [x] Wrap non-`AppLayout` routes in `PageErrorBoundary` — on main `8e51988`: `/tv-display`, `/time-clock`, `/lab-status`, `/login`, `/orders/receive`, `/reset-password`, `/change-password`

### Per-page sweep — for each: labels (`htmlFor`/`id` or `aria-label`), keyboard-operable clickables (`role`, `tabIndex`, `onKeyDown`), `useDialogA11y` on every modal, `focus-visible` rings, icon-button `aria-label`, `alt` text, 44px targets, live regions

Student-facing first:
- [ ] `TimeCardsPage.jsx` (~25 unlabeled controls, 8 clickable divs, hand-rolled overlay)
- [ ] `LabSignupPage.jsx` (4 icon-only buttons, 6 clickable divs)
- [ ] `AbsenceRequestPage.jsx`
- [ ] `AssetCheckoutsPage.jsx`
- [ ] `VolunteerHoursPage.jsx` (~21 unlabeled, 6 clickable divs)
- [ ] `DashboardPage.jsx`
- [ ] `BugTrackerPage.jsx` (~12 unlabeled, 1 `outline-none`)
- [ ] `AssetScanPage.jsx` (dialog without `useDialogA11y`)
- [ ] `TimeClockPage.jsx` (kiosk)
- [ ] `LabStatusPage.jsx` (dialog without `useDialogA11y`)

Instructor / admin:
- [ ] `WorkOrdersPage.jsx` (~24 unlabeled, 10 clickable divs)
- [ ] `SettingsPage.jsx` (~22 unlabeled, 6 clickable divs)
- [ ] `ProgramBudgetPage.jsx` (~23 unlabeled, 1 icon-only button)
- [ ] `SyllabusWizard.jsx` (~21 unlabeled, 7 `outline-none`, 1 icon-only button)
- [ ] `InstructorToolsPage.jsx` (6 `outline-none`)
- [ ] `CourseOutlineRevisionWizard.jsx`, `CourseProposalWizard.jsx`, `ProgramRevisionWizard.jsx`, `CourseEndDateWizard.jsx` (each has hand-rolled overlay without `role="dialog"`)
- [ ] `PurchaseOrdersPage.jsx` (~12 unlabeled, overlay)
- [ ] `InventoryPage.jsx` (~13 unlabeled, 6 clickable divs, 1 `<img>` without `alt`)
- [ ] `AssetsPage.jsx` (~15 unlabeled, 1 `<img>` without `alt`, dialog without hook)
- [ ] `UsersPage.jsx` (6 clickable divs, dialog without hook)
- [ ] `SOPsPage.jsx` (10 clickable divs)
- [ ] `AccessPage.jsx` (dialog without hook)
- [ ] `NetworkMapPage.jsx` (dialog without hook, `outline-none`)
- [ ] `ProgramPlannerPage.jsx`, `ProgramCostPage.jsx` (overlays, icon-only button)
- [ ] `WeeklyLabsTrackerPage.jsx` (overlay)
- [ ] `PMPage.jsx` (`outline-none`)
- [ ] `components/NotificationBell.jsx` (7 clickable divs)
- [ ] `components/RejectionModal.jsx`, `components/holds/StudentHoldsTab.jsx`, `components/EmulationBar.jsx` (dialog/overlay without hook)
- [ ] `AppLayout.jsx` (5 clickable divs, overlay)

### Documents
- [ ] Re-verify Syllabus and Course Outline `.docx` exports still score 100% in Ally after any `docx` package bump

## P3 — House conventions

- [ ] **Date convention sweep** (~450 `new Date().toISOString()` / `toLocale*String()` uses). Replace with `localToUtcIso()` / `getUTC*` helpers. Highest counts: `WorkOrdersPage`, `NotificationBell`, `useBugTracker`, `SOPsPage`, `AssetsPage`, `AnnouncementsPage`, `usePurchaseOrders`, `SyllabusWizard`, `useWeeklyLabs`, `usePMSchedules`, `useNetworkMap`, `useEquipment`, `AppLayout`, `WeeklyLabsTrackerPage`, `UsersPage`, `TimeCardsPage`, `ProgramBudgetPage`, `DashboardPage`
- [ ] **`.select()` + row-count validation on all writes** (~380 chains missing it). Highest counts: `NotificationBell`, `usePurchaseOrders`, `useBugTracker`, `SOPsPage`, `usePMSchedules`, `useVolunteerHours`, `WorkOrdersPage`, `useTimeCards`, `UsersPage`, `AnnouncementsPage`, `AppLayout`, `useSettings`
- [ ] **`mustData()`** on reads that gate a write or feed a user-visible number (currently 6 files use it)
- [ ] **`subscribeWithReconnect()`** replaces raw `supabase.channel()` in: `NotificationBell`, `usePurchaseOrders`, `useStudentHolds`, `AuthContext` (5 channels), `InstructorToolsPage`, `WorkOrdersPage`, `ProgramCostPage`, `SettingsPage`, `SOPsPage`
- [ ] `useTimeCards.js` — four `buildClassWeeks` call sites should pass the offset explicitly

## P4 — Code health

- [x] **Route-level code splitting** — on main `8e51988` (main chunk 3.8 MB → 1.0 MB) — `React.lazy()` + `<Suspense fallback={<PageLoading />}>` in `App.jsx`. Main chunk is 3.8 MB (984 KB gz). Keep `LoginPage`, `DashboardPage`, kiosk pages eager.
- [ ] **Delete dead files** (verify unreferenced first):
  - [ ] `src/pages/NotificationBell.jsx` (1,461-line stale duplicate of `components/NotificationBell.jsx`)
  - [ ] `src/hooks/useWorkOrders.js`
  - [ ] `src/hooks/useAssets.js`
  - [ ] `src/hooks/useInventory.js`
  - [ ] `src/hooks/useSOPs.js`
  - [ ] `src/hooks/useViewTracker.js`
  - [ ] `src/pages/CourseRevisionWizard.jsx`
- [ ] **Deferred pooled-scanner follow-ups** (not on main):
  - [ ] Exclude `POOL-SCANNER` rows from instructor checked-out count in `DashboardPage.jsx`
  - [ ] Hide pooled asset's checkout indicator in `AssetsPage.jsx`
- [ ] Add `.gitattributes` with `*.bat text eol=crlf` so batch files keep CRLF on commit
- [ ] Dependency bumps (minor, safe): `@supabase/supabase-js`, `react-router-dom`, `react`, `date-fns`, `docx`, `fflate`
- [ ] Dependency bumps (major, plan separately): `vite` 6→8, `@vitejs/plugin-react` 4→6, `tailwindcss` 3→4, `lucide-react` 0.468→1.x
- [ ] Main chunk still ~1 MB: `docx`/`fflate` are pulled in statically somewhere eager (likely `AppLayout` → `SyllabusLibraryModal` or `syllabusDocx.js`). Make those imports dynamic to shrink it further.
- [ ] `fflate` mixed static/dynamic import warning (`syllabusDocx.js` static vs `CourseProposalWizard.jsx` / `courseOutlineDocx.js` dynamic) — make consistent
- [ ] `AuthContext` opens 5 realtime channels — review whether they can be consolidated
- [ ] Consider `PageErrorBoundary` audit_log rows: make sure they don't capture PII in error messages

## Previously deferred features (from earlier sessions)

- [ ] Student Notes feature — resume after Brad/Katie input on categories and edit rights
- [ ] Program Budget page AY filtering
- [ ] ProgramPlannerPage polish (staggered PM roll-forward, per-semester credit validation)
- [ ] AI integration pilots (changelog drafting, WO triage) — FERPA review first
- [ ] Move working copy out of OneDrive if policy allows (`.git/HEAD` corruption)

---

## Verification steps for every delivery
- [ ] `npx esbuild --loader:.jsx=jsx --bundle=false <file>` passes
- [ ] Line endings preserved (CRLF vs LF checked per file)
- [ ] `vite build` passes
- [ ] Changelog title + bug_tracker description written
- [ ] Session ends with clone-vs-delivered diff; unpushed files listed
