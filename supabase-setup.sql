-- ============================================================================
-- RICT CMMS — Supabase Setup for React Frontend
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- ============================================================================

-- ─── get_next_id function ───────────────────────────────────────────────────
-- Generates sequential IDs like WO-0001, LOG-0001, etc.
-- This replaces the Google Sheets "Counters" tab functionality.

CREATE OR REPLACE FUNCTION get_next_id(id_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  prefix TEXT;
  current_val INTEGER;
  next_val INTEGER;
  result TEXT;
BEGIN
  -- Map id types to prefixes
  CASE id_type
    WHEN 'work_order' THEN prefix := 'WO';
    WHEN 'work_log' THEN prefix := 'LOG';
    WHEN 'work_order_request' THEN prefix := 'REQ';
    WHEN 'asset' THEN prefix := 'AST';
    WHEN 'inventory' THEN prefix := 'INV';
    WHEN 'purchase_order' THEN prefix := 'PO';
    WHEN 'pm_schedule' THEN prefix := 'PM';
    WHEN 'bug' THEN prefix := 'BUG';
    ELSE prefix := UPPER(id_type);
  END CASE;

  -- Get or create counter row
  INSERT INTO counters (counter_name, counter_value)
  VALUES (id_type, 0)
  ON CONFLICT (counter_name) DO NOTHING;

  -- Increment and return
  UPDATE counters
  SET counter_value = counter_value + 1
  WHERE counter_name = id_type
  RETURNING counter_value INTO next_val;

  result := prefix || '-' || LPAD(next_val::TEXT, 4, '0');
  RETURN result;
END;
$$;

-- ─── counters table (if not exists) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS counters (
  counter_name TEXT PRIMARY KEY,
  counter_value INTEGER NOT NULL DEFAULT 0
);

-- ─── Ensure work_orders has all columns the frontend expects ────────────────
-- (Run these only if columns are missing — they're safe if columns exist)

DO $$ 
BEGIN
  -- Add closed_date if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'work_orders' AND column_name = 'closed_date') THEN
    ALTER TABLE work_orders ADD COLUMN closed_date TIMESTAMPTZ;
  END IF;

  -- Add closed_by if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'work_orders' AND column_name = 'closed_by') THEN
    ALTER TABLE work_orders ADD COLUMN closed_by TEXT;
  END IF;

  -- Add days_open if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'work_orders' AND column_name = 'days_open') THEN
    ALTER TABLE work_orders ADD COLUMN days_open INTEGER;
  END IF;

  -- Add was_late if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'work_orders' AND column_name = 'was_late') THEN
    ALTER TABLE work_orders ADD COLUMN was_late TEXT;
  END IF;

  -- Add updated_by if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'work_orders' AND column_name = 'updated_by') THEN
    ALTER TABLE work_orders ADD COLUMN updated_by TEXT;
  END IF;
END $$;

-- ─── Indexes for fast queries ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_wo_assigned ON work_orders(assigned_to);
CREATE INDEX IF NOT EXISTS idx_wo_created ON work_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wo_priority ON work_orders(priority);
CREATE INDEX IF NOT EXISTS idx_worklog_woid ON work_log(wo_id);
CREATE INDEX IF NOT EXISTS idx_woparts_woid ON work_order_parts(wo_id);

-- ─── RLS policies for the frontend ─────────────────────────────────────────
-- These allow authenticated users to read work orders.
-- Adjust as needed for your role-based permissions.

-- Allow all authenticated users to read work orders
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can read work orders'
  ) THEN
    CREATE POLICY "Anyone can read work orders" ON work_orders
      FOR SELECT USING (true);
  END IF;
END $$;

-- Allow all authenticated users to insert work orders
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can create work orders'
  ) THEN
    CREATE POLICY "Authenticated users can create work orders" ON work_orders
      FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- Allow all authenticated users to update work orders
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can update work orders'
  ) THEN
    CREATE POLICY "Authenticated users can update work orders" ON work_orders
      FOR UPDATE USING (true);
  END IF;
END $$;

-- Allow all authenticated users to delete work orders
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can delete work orders'
  ) THEN
    CREATE POLICY "Authenticated users can delete work orders" ON work_orders
      FOR DELETE USING (true);
  END IF;
END $$;

-- ─── Similar policies for related tables ────────────────────────────────────

-- Work Log
ALTER TABLE work_log ENABLE ROW LEVEL SECURITY;
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can read work log') THEN
    CREATE POLICY "Anyone can read work log" ON work_log FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated can insert work log') THEN
    CREATE POLICY "Authenticated can insert work log" ON work_log FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated can delete work log') THEN
    CREATE POLICY "Authenticated can delete work log" ON work_log FOR DELETE USING (true);
  END IF;
END $$;

-- Work Order Parts
ALTER TABLE work_order_parts ENABLE ROW LEVEL SECURITY;
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can read wo parts') THEN
    CREATE POLICY "Anyone can read wo parts" ON work_order_parts FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated can insert wo parts') THEN
    CREATE POLICY "Authenticated can insert wo parts" ON work_order_parts FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated can delete wo parts') THEN
    CREATE POLICY "Authenticated can delete wo parts" ON work_order_parts FOR DELETE USING (true);
  END IF;
END $$;

-- Assets (read-only for now)
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can read assets') THEN
    CREATE POLICY "Anyone can read assets" ON assets FOR SELECT USING (true);
  END IF;
END $$;

-- Users (read-only for now)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can read users') THEN
    CREATE POLICY "Anyone can read users" ON users FOR SELECT USING (true);
  END IF;
END $$;

-- Audit Log
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can read audit log') THEN
    CREATE POLICY "Anyone can read audit log" ON audit_log FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated can insert audit log') THEN
    CREATE POLICY "Authenticated can insert audit log" ON audit_log FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- WO Statuses
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wo_statuses') THEN
    ALTER TABLE wo_statuses ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anyone can read wo statuses') THEN
      CREATE POLICY "Anyone can read wo statuses" ON wo_statuses FOR SELECT USING (true);
    END IF;
  END IF;
END $$;

-- Counters
ALTER TABLE counters ENABLE ROW LEVEL SECURITY;
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service role manages counters') THEN
    CREATE POLICY "Service role manages counters" ON counters FOR ALL USING (true);
  END IF;
END $$;


-- ============================================================================
-- Done! Your React frontend should now be able to connect to Supabase.
-- ============================================================================
