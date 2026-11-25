// Types for the Go class defined by Go's wasm_exec.js.
declare global {
  class Go {
    argv: string[];
    env: Record<string, string>;
    exit: (code: number) => void;
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
    /** Internal: timers scheduled by the Go runtime (id -> timeout handle). */
    _scheduledTimeouts?: Map<number, ReturnType<typeof setTimeout>>;
  }
}

export {};
