/** Safe operational diagnostics for CLI smoke tests; never print credential-bearing errors. */
export class SmokeLogger {
  constructor(moduleName) {
    this.moduleName = moduleName;
  }

  exception(event, error) {
    console.warn(this.moduleName + '.' + event, {
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}
