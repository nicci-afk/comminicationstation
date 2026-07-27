-- Add birthday to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS birthday date;
