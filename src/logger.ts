/**
 * Logger interface — abstracts console output so the TUI can capture it.
 *
 * The dispatcher accepts a Logger at construction time:
 * - ConsoleLogger (default) writes directly to stdout/stderr
 * - TUILogger pushes entries into ink's render cycle
 */

export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class ConsoleLogger implements Logger {
  log(message: string): void {
    console.log(message);
  }
  warn(message: string): void {
    console.warn(message);
  }
  error(message: string): void {
    console.error(message);
  }
}
