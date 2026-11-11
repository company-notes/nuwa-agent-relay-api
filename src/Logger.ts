/** Logs operational failures without recording request bodies, URLs or secrets. */
export class Logger {
  private constructor(private readonly moduleName: string) {}

  static forModule(moduleName: string): Logger {
    return new Logger(moduleName);
  }

  warning(event: string, details: Record<string, string | number | boolean> = {}): void {
    console.warn(this.moduleName + '.' + event, details);
  }

  exception(
    event: string, error: unknown,
    details: Record<string, string | number | boolean> = {},
  ): void {
    // Error messages and stacks can contain credential-bearing callback URLs.
    console.error(this.moduleName + '.' + event, {
      ...details,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}
