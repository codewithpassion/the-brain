-- Phase multi-org: add created_by to the orgs table.
-- NULL for rows that existed before this migration (auto-provisioned personal orgs).
ALTER TABLE `orgs` ADD COLUMN `created_by` text;
