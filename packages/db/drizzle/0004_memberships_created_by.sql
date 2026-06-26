-- Phase write-provenance: add created_by to the memberships table.
-- NULL for rows that existed before this migration (auto-provisioned personal memberships and
-- org-create owner memberships inserted before this column was added).
ALTER TABLE `memberships` ADD COLUMN `created_by` text;
