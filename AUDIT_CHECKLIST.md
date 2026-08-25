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
- [x] **Student name privacy sweep** — audited 2026-08-24 against `207e69a`. Rule: students and work study see other people as "First L."; instructors keep full names. Added `shortName(fullName)` to `src/lib/utils.js` for `user_name` strings (use `displayName(profile)` for profile objects).
  - [x] Lab Signup — clean (students see counts only; name lists behind `manage_others`)
  - [x] Dashboard — clean (name lists only in `InstructorOverview`, behind `Users → view_page`)
  - [x] Weekly Labs — clean (student view shows own name / instructor only)
  - [x] Equipment Scheduling — fixed: grid cell + aria-label for other people's bookings now "First L."
  - [x] TV Display — already abbreviated via local `firstLastInit()`
  - [x] Lab Status kiosk — fixed: help-request card now "First L." (people list was already abbreviated)
  - [x] Work Orders detail modal (`components/WorkOrderDetailModal.jsx`) — assignee chips, primary assignee, created-by and work-log authors now "First L." for non-instructors (2026-08-24). List page already shortened.
  - [x] Instructor-tier pages swept during the accessibility pass: Work Orders detail + SOPs fixed; Inventory/Assets/PM/PO/Network render no student names
  - [ ] Review Access page: if any Work Study role holds `manage_others`, `view_all_students`, `manage_all_bookings`, or `Users → view_page`, they see full names on those screens
  - [x] Cleanup: `TVDisplayPage.jsx` now uses shared `shortName()` (2026-08-25)
  - [x] Asset checkouts / Absence requests — students only see their own rows (confirmed 2026-08-24); Lab Signup, Time Cards, Dashboard audited clean
- [x] **Centralize super-admin exclusion.** Delivered 2026-08-24.
  - [x] Add `SUPER_ADMIN_EMAIL` constant + `isSuperAdmin()` / `isSuperAdminEmail()` / `excludeSuperAdmin()` helpers in `src/lib/superAdmin.js`
  - [x] Replace all 16 hardcoded sites across 15 files (EmulationBar, AppLayout, useBugTracker, useSettings, useAbsenceRequests, usePermissions, AuthContext, ProgramPlannerPage, AbsenceRequestPage, AccessPage, SettingsPage, LabStatusPage, AssetScanPage, AssetsPage, AnnouncementsPage)
  - [ ] Server-side: `profiles_public` view so the client can't forget. Risk: 30+ files query `profiles` and a few (login, AuthContext, EmulationBar, AccessPage) must still see the super admin — needs its own session with testing.
  - [ ] Audit the 24 files that query `profiles` with no filter; confirm none feed a student-visible picker
- [x] **`xlsx` 0.18.5 → SheetJS 0.20.3 via CDN tarball** (2026-08-25): `package.json` now points `xlsx` at `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; `GlossaryModal` and `useProgramBudget` no longer fetch SheetJS from the CDN at runtime (they import the bundled copy like the other five files). Run `npm install` and commit `package-lock.json`. Original note: Options: install SheetJS from `cdn.sheetjs.com` tarball (0.20.x) or migrate exports to `exceljs`. Decide and implement.
- [x] PII `console.log`s gated behind `import.meta.env.DEV` (2026-08-25): 12 calls in `AuthContext`, `TimeClockPage`, `AppLayout`, `usePushNotifications` that printed emails/names. Remaining ~110 logs are non-PII diagnostics — optional cleanup.

## P2 — Accessibility (Section 508 / WCAG 2.1 AA)

Do one page per session. Start with student-facing pages.

### App-wide
- [x] Global `:focus-visible` outline for buttons/links/inputs without Tailwind focus classes (`src/index.css`, 2026-08-24) — covers inline-styled pages and kiosks
- [x] Add skip-to-content link in `AppLayout.jsx` (target `<main id="main-content">`) — WCAG 2.4.1 (2026-08-24)
- [x] Shared `Field` added to `src/components/ui` (2026-08-25): `import { Field } from '@/components/ui'` — auto-links label↔control via `useId()`, announces required, ties hints via `aria-describedby`. Use for new forms; the 7 pages with a local `Field` can migrate opportunistically.
- [x] Replace `window.confirm` / `alert` with `ConfirmDialog`/toasts — done page-by-page during the sweep (2026-08-24); re-grep before closing: `grep -rnE "\b(confirm|alert)\(" src`
- [x] Wrap non-`AppLayout` routes in `PageErrorBoundary` — on main `8e51988`: `/tv-display`, `/time-clock`, `/lab-status`, `/login`, `/orders/receive`, `/reset-password`, `/change-password`

### Per-page sweep — for each: labels (`htmlFor`/`id` or `aria-label`), keyboard-operable clickables (`role`, `tabIndex`, `onKeyDown`), `useDialogA11y` on every modal, `focus-visible` rings, icon-button `aria-label`, `alt` text, 44px targets, live regions

Student-facing first:
- [x] `TimeCardsPage.jsx` — delivered 2026-08-24: `ModalOverlay` now uses `useDialogA11y` + `role="dialog"`; `Field` links labels via `useId()`; aria-labels on 11 icon buttons; keyboard toggle for week rows; `aria-pressed` on tabs; focus rings + 44px on all buttons; `scope="col"` on all headers; decorative icons hidden; loading spinners announced
- [x] `LabSignupPage.jsx` — delivered 2026-08-24: Change Request + Slot Detail modals wired to `useDialogA11y` with `role="dialog"`; `window.confirm` on My Signups replaced with `ConfirmDialog`; aria-labels on nav/close/cancel buttons; reason textarea labelled; week title is a live region; tabs `aria-pressed`; focus rings + 44px on all buttons; `scope="col"`; decorative icons hidden
- [x] `AbsenceRequestPage.jsx` — audited 2026-08-24: already compliant (dialogs, labels, live regions, focus rings); only fix needed was 44px targets on 10 buttons
- [x] `AssetCheckoutsPage.jsx` — audited 2026-08-24: already compliant (4 dialogs on `useDialogA11y`, tablist, labels, icons hidden); fixed 44px on 21 buttons, `scope="col"` in the printed equipment report, `alert()` → toast
- [x] `VolunteerHoursPage.jsx` — delivered 2026-08-24: 4 remaining modals (Log Volunteer, Log Club, Edit Request, Report) wired to `useDialogA11y` with `role="dialog"`; aria-labels on refresh/close/correction buttons; keyboard toggle for student rows; `aria-pressed` on filters and report-type toggles; `alert()` → toast; focus rings + 44px; `scope="col"`; icons hidden. (Fields were already labelled — `Field` wraps in `<label>`.)
- [x] `DashboardPage.jsx` — audited 2026-08-24: already compliant (3 dialogs on `useDialogA11y`, card headers are keyboard buttons with `aria-expanded`, focus styles in `dashboard.css`, 6 live regions, headers scoped). Fixed 44px targets via `dashboard.css` (`.dash-btn-sm`, `.dash-btn-reject`, `.dash-btn-primary`, `.dash-btn-cancel`, `.dash-modal-close` at all viewports)
- [x] `BugTrackerPage.jsx` — delivered 2026-08-24: `Field` auto-links labels via `useId()`; Changelog Detail, Add Changelog and Confirm dialogs wired to `useDialogA11y` (Confirm is `alertdialog`); `ActionBtn` icon buttons named from their tooltip; search/filter controls labelled with focus ring; changelog version rows and item titles are keyboard buttons with `aria-expanded`; focus rings + 44px; `scope="col"`; icons hidden
- [x] `AssetScanPage.jsx` — delivered 2026-08-24: all 4 dialogs (lightbox, edit asset, check-out, check-in) on `useDialogA11y`; both `window.confirm` deletes → `ConfirmDialog`; edit-form labels linked; asset photo is a keyboard button; back/scan/close/doc icon buttons named; WO/Docs toggles `aria-expanded`/`aria-pressed`; 44px on doc buttons and close ×; material icons hidden
- [x] `TimeClockPage.jsx` (kiosk) — delivered 2026-08-24: already largely compliant (badge inputs labelled, no dialogs); added `role="alert"` on errors, `role="status"` on lookup/verify spinners and the success screen, student search label, decorative SVGs hidden, focus rings + 44px on all 9 buttons
- [x] `LabStatusPage.jsx` (kiosk) — delivered 2026-08-24: instructor-select overlay already had its own dialog semantics + keyboard handling (audit flag was a false positive); help-card action button now names the student; 18 decorative material icons hidden; local `firstLastInit()` replaced with shared `shortName()`

Instructor / admin:
- [x] `WorkOrdersPage.jsx` — delivered 2026-08-24: all 7 dialogs were already on `useDialogA11y` and the row open-link was already a button; fixed 15 form labels linked by id + 8 loose controls labelled (PO line items, hours/mins group, filters); parts search results and remove-part are real buttons; approve/reject/remove icon buttons named; `scope="col"`; 15 material icons hidden; embedded CSS: 44px on `.btn`, `.btn-sm`, `.action-btn`, `.modal-close`, `.filter-select`, visible `.form-input:focus` ring
- [x] `SettingsPage.jsx` — delivered 2026-08-24: 22 form controls linked to labels (CRUD sections via `useId`, class form, duplicate-class form); both `window.confirm` deletes (CRUD items, classes) → `ConfirmDialog`; Duplicate Class + Manage Enrollment modals on `useDialogA11y` with `role="dialog"`; `scope="col"` on 13 headers; focus rings + 44px on all buttons; `settings.css` tab/segmented/day/clear buttons raised to 44px. (Icons, live regions, and the three other dialogs were already compliant.)
- [x] `ProgramBudgetPage.jsx` — delivered 2026-08-24: 13 label/control pairs linked; toolbar search/filters, inline-edit row fields, and import checkboxes labelled; void/delete `window.confirm` → `ConfirmDialog`; refresh/details/edit/void/delete icon buttons named (details has `aria-expanded`); tabs `aria-pressed`; loading state `role="status"`; `scope="col"`; 53 icons hidden; focus rings + 44px on all 26 buttons
- [x] `SyllabusWizard.jsx` — delivered 2026-08-24: `Field` now links label→control via `useId()` (TI/NI/TA/Sel helpers accept id; ItemList rows self-label; required marked, hints via `aria-describedby`); 9 loose label pairs + 8 other controls labelled; wizard shell and Materials Catalog picker are `role="dialog"` on `useDialogA11y` (Escape = X); 9 icon buttons named (remove-item button now visible on keyboard focus); 6 `outline-none` controls given rings; 43 icons hidden; focus rings + 44px on all 48 buttons incl. step circles and move/remove controls
- [x] `InstructorToolsPage.jsx` — delivered 2026-08-24: all 5 dialogs were already on `useDialogA11y` and forms labelled; tool tiles' "Open …" row is now a real button (card click kept for mouse); catalog search/filter/clear and logo URL inputs labelled; edit/delete row icons named and shown on keyboard focus; 6 `outline-none` controls given rings; `scope="col"`; 51 icons hidden; focus rings + 44px on all 41 buttons
- [x] `CourseOutlineRevisionWizard.jsx`, `CourseProposalWizard.jsx`, `ProgramRevisionWizard.jsx`, `CourseEndDateWizard.jsx` — delivered 2026-08-24: each wizard shell is `role="dialog"` on `useDialogA11y` (Escape = X, focus trap/restore); `Field` links labels via `useId()` (Inp/Tex/Num helpers accept ids; required/hint announced); every grid/table input labelled by row ("Assessment for outcome 3"); remove/close icon buttons named; `scope="col"`; all icons hidden; focus rings + 44px on all buttons incl. step circles
- [x] `PurchaseOrdersPage.jsx` — delivered 2026-08-24: QR scanner, Order Part and Adjust Stock Levels overlays are `role="dialog"` on `useDialogA11y`; 7 form labels + 5 per-line-item labels linked by id; PO list rows open via a keyboard button on the ID; validation `alert()`s → toast; close/scanner icon buttons named; `scope="col"`; 50 icons hidden; focus rings + 44px on all 36 buttons. (Printed PO HTML untouched.)
- [x] `InventoryPage.jsx` — delivered 2026-08-24: all 5 modals (Add/Edit Part, Part Details, Adjust Quantity, Print Labels, Confirm) on `useDialogA11y` with `role="dialog"`/`alertdialog`; 10 form labels linked; search/filters labelled; part-name cell is a keyboard button; view/adjust/edit/delete icons named; `scope="col"` on 17 headers; 29 material icons hidden; label-print `<img>` alt; embedded CSS: 44px on `.btn`, `.btn-sm`, `.action-btn`, `.modal-close`, `.filter-select`, visible focus on `.form-input` and search box. No other-student names rendered on this page.
- [x] `AssetsPage.jsx` — delivered 2026-08-24: all 11 dialogs (8 page modals + Check Out / Check In / History) on `useDialogA11y` (they had `role="dialog"` but no focus trap/Escape); 20 `alert()`s → toasts, 3 `confirm()`s → promise-based `ConfirmDialog` (`askConfirm`); 8 form labels linked; image upload area keyboard-operable; label-print checkboxes named; SOP/delete/remove-image icon buttons named; `scope="col"`; 26 material icons hidden; QR `<img>` alt; embedded CSS: 44px on `.btn`, `.btn-sm`, `.action-btn`, `.modal-close`, `.filter-select`, `.remove-image-btn`, visible focus on `.form-input`/search. Table rows were already keyboard-operable; checkout names already shortened.
- [x] `UsersPage.jsx` — delivered 2026-08-24: already well-built (labels, dialog roles, named action icons, tablist, live regions); added `useDialogA11y` focus trap/restore to all 6 modals; 7 `alert()`s → toasts; 51 icons hidden; focus rings + 44px on all 44 buttons
- [x] `SOPsPage.jsx` — delivered 2026-08-24: all 9 modals given `role="dialog"`/`alertdialog` + `useDialogA11y`; SOP cards keyboard-operable; 17 `alert()`s → toasts; search inputs and 4 form labels linked; unlink/remove-file/clear/dismiss icon buttons named; 56 material icons hidden; embedded CSS: 44px on all `.sops-btn-*` classes and icon buttons (focus visible via global rule + existing input focus styles). Also: SOP "Created By" now "First L." for non-instructors
- [x] `AccessPage.jsx` — 2026-08-24: 3 dialogs on `useDialogA11y` (roles/labels already present); `scope="col"`; focus rings + 44px on all buttons
- [x] `NetworkMapPage.jsx` — 2026-08-24: shared `Modal` already had its own focus trap/Escape (false positive); asset search input given focus ring; 2 icons hidden; 44px on all 31 buttons
- [x] `ProgramPlannerPage.jsx` — 2026-08-24: 4 dialogs (Delete Semester, Plan Editor, New Plan, Student Plan View) on `useDialogA11y` with roles; 11 icon buttons named; 9 controls labelled incl. per-row grid inputs; `scope="col"` on 20 headers; 44 icons hidden; focus rings + 44px on all 34 buttons
- [x] `ProgramCostPage.jsx` — 2026-08-24: Tuition & Fees dialog on `useDialogA11y`; 12 rate/fee inputs + materials cost labelled; `scope="col"`; 18 icons hidden; focus rings + 44px on all 14 buttons
- [x] `WeeklyLabsTrackerPage.jsx` — 2026-08-24: Sign Off + All Done modals on `useDialogA11y` with roles; "Mark as Done" `window.confirm` → `ConfirmDialog`; close/sign-off icon buttons named; Select Class linked; `scope="col"`; 54 icons hidden; focus rings + 44px on all buttons
- [x] `PMPage.jsx` — 2026-08-24: PM form modal on `useDialogA11y` with role; 3 `window.confirm`s → `askConfirm`/`ConfirmDialog` (open-WO warning now offers to open Work Orders); 2 `alert()`s → toasts; search/filter labelled; close button named; 36 icons hidden; focus rings + 44px
- [x] `components/NotificationBell.jsx` — 2026-08-24: 4 dialogs already on the hook; permission/lab-change approval rows now have real labelled checkboxes; 3 labels linked; 44px + focus via `notification-bell.css`
- [x] `components/RejectionModal.jsx` — verified: has its own focus trap/Escape; audit flag was a false positive
- [x] `components/holds/StudentHoldsTab.jsx` — 2026-08-24: Delete Hold `alertdialog` on `useDialogA11y`; date/search inputs labelled; 14 icons hidden; 44px + focus on 16 buttons
- [x] `components/EmulationBar.jsx` — 2026-08-24: picker is `role="dialog"` (already had trap/Escape); draggable trigger keyboard-operable; close/search labelled
- [x] `AppLayout.jsx` — 2026-08-24: skip link + `main#main-content`; Change Password and Temp Access dialogs on `useDialogA11y`; 4 `alert()`s → toasts; permission page headers keyboard-operable with `aria-expanded`, permission checkboxes real and labelled; 8 fields linked; menu/sign-out/password/planner icon buttons named; 25 icons hidden; 44px + focus on all buttons

### Documents
- [ ] Re-verify Syllabus and Course Outline `.docx` exports still score 100% in Ally after any `docx` package bump

## P3 — House conventions

- [x] **Date convention sweep — resolved 2026-08-25 without a mass rewrite.** Survey found two deliberate conventions split by table, each internally consistent (see `TIMESTAMP_CONVENTIONS.md`). Verified against live rows + `audit_log`: `time_entry_requests`, `lab_signup_requests`, `weekly_lab_tracker.created_at` are real UTC; `absence_requests` is fake-UTC throughout. **No mixed writes found**, so the ~450 `toISOString`/`toLocale*` hits are correct for their tables. Remaining note: `reverted_date` is written as real-UTC `new Date().toISOString()` in both `DashboardPage.jsx` (revoke) and `AppLayout.jsx`; change both together with `localToUtcIso()` when doing the sweep so they stay consistent
- [x] **Date convention sweep (list)** — see above; only touch these files if a table changes convention (~450 `new Date().toISOString()` / `toLocale*String()` uses). Replace with `localToUtcIso()` / `getUTC*` helpers. Highest counts: `WorkOrdersPage`, `NotificationBell`, `useBugTracker`, `SOPsPage`, `AssetsPage`, `AnnouncementsPage`, `usePurchaseOrders`, `SyllabusWizard`, `useWeeklyLabs`, `usePMSchedules`, `useNetworkMap`, `useEquipment`, `AppLayout`, `WeeklyLabsTrackerPage`, `UsersPage`, `TimeCardsPage`, `ProgramBudgetPage`, `DashboardPage`
- [ ] **`.select()` + row-count validation on all writes.** Added `assertWrite(result, label)` to `src/lib/supabaseData.js` (2026-08-24): append `.select()` to the write, pass through `assertWrite`, keep the existing `if (error)` handling — zero affected rows now surfaces as an error. Batch 1 done: 34 primary writes (`const { error } = await …` shape) in `useBugTracker`, `usePMSchedules`, `useTimeCards`, `useVolunteerHours`, `usePurchaseOrders`, `useSettings`. Batch 2 done: 74 more primary writes across 23 files (all remaining `const { error } = await …` writes app-wide). Still to do: fire-and-forget writes (`await supabase.from(...).update(...)` with no destructure — mostly `audit_log` and secondary updates), (~170, mostly `audit_log` inserts and secondary status updates that intentionally don't block the user — review case by case; the ones that matter are secondary updates in `usePurchaseOrders`, `NotificationBell`, `AnnouncementsPage`).
  - ⚠ Smoke-test after deploy: if a table's RLS allows UPDATE/DELETE but not SELECT on the same rows, `.select()` returns 0 rows and the action will now report "no rows were affected". Fix is to grant SELECT in the policy, not to remove the check.
  - Original note: Highest counts: `NotificationBell`, `usePurchaseOrders`, `useBugTracker`, `SOPsPage`, `usePMSchedules`, `useVolunteerHours`, `WorkOrdersPage`, `useTimeCards`, `UsersPage`, `AnnouncementsPage`, `AppLayout`, `useSettings`
- [x] **`mustData()`** on reads that gate a write or feed a user-visible number. Batch 1 (2026-08-25): 111 reads in all hooks + `AuthContext` + ID generators that previously ignored `error` (`const { data } = await …` with no error check) now go through `mustData()`. Only sites already inside a `try/catch` were converted, so a failed read surfaces through the existing handler instead of silently returning an empty list. Batch 2 (2026-08-25): 139 more reads across 26 pages/components — every remaining error-ignoring read that sits inside a `try/catch`. ~30 reads outside any try/catch left alone deliberately (converting those would turn a silent empty into an unhandled crash).
- [x] **`subscribeWithReconnect()`** — 2026-08-24: 17 raw `supabase.channel()` subscriptions converted across `NotificationBell`, `usePurchaseOrders` (3), `useStudentHolds` (2), `AuthContext` (4), `InstructorToolsPage`, `WorkOrdersPage`, `ProgramCostPage`, `SettingsPage` (4), `SOPsPage`. The one remaining raw channel is the presence channel in `AuthContext` (`online-users-presence`) — it needs the channel object for `presenceState()`/`track()`, which the helper doesn't expose; leave as-is or extend the helper later.
- [x] `useTimeCards.js` — time entry requests and edit requests now write an `audit_log` entry like the volunteer paths do (2026-08-25; TER001066 had none)
- [x] `useTimeCards.js` — lab-days setting is now fetched in `generateUserReport` and `fetchTimeCard`, and all four `buildClassWeeks` calls pass the offset explicitly (2026-08-25)

## P4 — Code health

- [x] **Route-level code splitting** — on main `8e51988` (main chunk 3.8 MB → 1.0 MB) — `React.lazy()` + `<Suspense fallback={<PageLoading />}>` in `App.jsx`. Main chunk is 3.8 MB (984 KB gz). Keep `LoginPage`, `DashboardPage`, kiosk pages eager.
- [x] **Delete dead files** — verified unreferenced and removed 2026-08-24 (build passes without them):
  - [x] `src/pages/NotificationBell.jsx` (1,461-line stale duplicate of `components/NotificationBell.jsx`)
  - [x] `src/hooks/useWorkOrders.js`
  - [x] `src/hooks/useAssets.js`
  - [x] `src/hooks/useInventory.js`
  - [x] `src/hooks/useSOPs.js`
  - [x] `src/hooks/useViewTracker.js`
  - [x] `src/pages/CourseRevisionWizard.jsx`
  - [x] `src/pages/AuthContext.jsx` (deleted 2026-08-24)
- [x] **Deferred pooled-scanner follow-ups** — both delivered 2026-08-24:
  - [x] Exclude `POOL-SCANNER` rows from instructor checked-out count in `DashboardPage.jsx` (delivered 2026-08-24)
  - [x] Hide pooled asset's checkout indicator in `AssetsPage.jsx` (delivered 2026-08-24)
- [x] `.gitattributes` on main (2026-08-25)
- [x] Dependency bumps (minor, 2026-08-25): `@supabase/supabase-js` 2.49→2.112, `react-router-dom` 7.1→7.18, `react`/`react-dom` 19.0→19.2, `date-fns` 4.1→4.4, `docx` 9.6→9.7, `fflate` 0.8.2→0.8.3. Clears the `react-router`, `nanoid` (via docx) and `ws` (via supabase) advisories. Build verified; `npm audit --omit=dev` should be 0 once `npm install` is run with the SheetJS tarball.
- [ ] Dependency bumps (major, plan separately): `vite` 6→8, `@vitejs/plugin-react` 4→6, `tailwindcss` 3→4, `lucide-react` 0.468→1.x
- [ ] Main chunk still ~1 MB: `docx`/`fflate` are pulled in statically somewhere eager (likely `AppLayout` → `SyllabusLibraryModal` or `syllabusDocx.js`). Make those imports dynamic to shrink it further.
- [ ] `fflate` mixed static/dynamic import warning (`syllabusDocx.js` static vs `CourseProposalWizard.jsx` / `courseOutlineDocx.js` dynamic) — make consistent
- [ ] `AuthContext` opens 5 realtime channels — review whether they can be consolidated
- [ ] Consider `PageErrorBoundary` audit_log rows: make sure they don't capture PII in error messages

## Previously deferred features (from earlier sessions)

- [x] ~~Student Notes feature~~ — not doing (decided 2026-08-25)
- [x] Program Budget page AY filtering — confirmed present: school-year selector on Overview, defaults to current year, drives all tabs
- [ ] ProgramPlannerPage polish (staggered PM roll-forward, per-semester credit validation)
- [x] ~~AI integration pilots~~ — not doing (decided 2026-08-25)
- [x] ~~Move working copy out of OneDrive~~ — not doing (decided 2026-08-25)

---

## Verification steps for every delivery
- [ ] `npx esbuild --loader:.jsx=jsx --bundle=false <file>` passes
- [ ] Line endings preserved (CRLF vs LF checked per file)
- [ ] `vite build` passes
- [ ] Changelog title + bug_tracker description written
- [ ] Session ends with clone-vs-delivered diff; unpushed files listed
