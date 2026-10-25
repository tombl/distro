// SPDX-License-Identifier: MIT

/** An error in a command's arguments, reported with the command's usage. */
export class UsageError extends Error {}

/**
 * The exit status of every lowland failure, from argument errors to a
 * machine that cannot run. Like `docker run`, lowland leaves the lower
 * statuses to the command it runs, and 126 and 127 to a command that cannot
 * be executed or is not found.
 */
export const EXIT_FAILURE = 125;
