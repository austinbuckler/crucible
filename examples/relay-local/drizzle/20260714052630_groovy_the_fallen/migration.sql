CREATE TABLE `todos` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
