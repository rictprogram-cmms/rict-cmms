# RICT CMMS — React + Supabase

Computerized Maintenance Management System for SCTCC Residential & Industrial Construction Technology.

## Quick Start

### Prerequisites
- Node.js 18+ installed
- Supabase project set up (Phase 1 complete)

### 1. Clone & Install
```bash
git clone <your-repo-url>
cd rict-cmms-react
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```

Edit `.env` with your Supabase credentials:
```
VITE_SUPABASE_URL=https://jzzfgafwyxabafaqrnho.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key-from-supabase-dashboard>
```

To find your anon key:
1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project → Settings → API
3. Copy the `anon` `public` key

### 3. Run the Supabase Setup SQL
If you haven't already, run the `supabase-setup.sql` file in your Supabase SQL Editor. This creates the `get_next_id` function needed for generating WO IDs.

### 4. Start Development
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Deploy to Vercel
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard:
# VITE_SUPABASE_URL
# VITE_SUPABASE_ANON_KEY
```

Or connect your GitHub repo to Vercel for automatic deploys.

## Project Structure

```
src/
├── App.jsx                    # Router + providers
├── main.jsx                   # Entry point
├── index.css                  # Global styles + Tailwind
├── lib/
│   ├── supabase.js            # Supabase client
│   └── utils.js               # Shared utilities
├── contexts/
│   └── AuthContext.jsx         # Auth state management
├── hooks/
│   └── useWorkOrders.js       # Work order data hooks
├── components/
│   ├── ui/
│   │   └── index.jsx          # Badge, Modal, Spinner, etc.
│   └── layout/
│       └── AppLayout.jsx      # Sidebar + header shell
└── pages/
    ├── LoginPage.jsx
    ├── ComingSoonPage.jsx
    └── work-orders/
        └── WorkOrdersPage.jsx # Full WO CRUD
```

## What's Included (Phase 2 - Sprint 1)

- ✅ Authentication (email/password via Supabase Auth)
- ✅ Sidebar navigation with role-based filtering
- ✅ Work Orders — list, search, filter, sort
- ✅ Work Orders — create, view details, change status
- ✅ Work Orders — close, reopen, delete (with permissions)
- ✅ Work Log — add entries with hours tracking
- ✅ Real-time updates (Supabase channels)
- ✅ Late work order highlighting
- ✅ Responsive design (mobile sidebar)

## Coming Next

- Assets page with image uploads
- Inventory page with QR scanning
- Time Clock page
- User Management
- PM Schedules, Reports, Purchase Orders (Phase 3)

## Tech Stack

- **Frontend**: React 19, React Router 7, Tailwind CSS 3
- **Backend**: Supabase (PostgreSQL, Auth, Real-time, Storage)
- **Build**: Vite 6
- **Deploy**: Vercel (free tier)
