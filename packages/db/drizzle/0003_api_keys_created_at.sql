-- Add created_at to api_keys (nullable; set explicitly on new rows).
ALTER TABLE `api_keys` ADD COLUMN `created_at` text;
