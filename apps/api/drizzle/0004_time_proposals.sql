CREATE TABLE `time_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`status` text NOT NULL,
	`document` text NOT NULL,
	FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `time_proposal_pending` ON `time_proposal` (`status`,`taskId`);