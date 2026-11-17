// Minimal types for the parts of QZ Tray (https://qz.io) that PrintFlow uses.
declare module 'qz-tray' {
  interface QzConfig {
    readonly printer: unknown;
  }
  interface Qz {
    websocket: {
      isActive(): boolean;
      connect(options?: { retries?: number; delay?: number }): Promise<void>;
      disconnect(): Promise<void>;
    };
    printers: {
      find(query?: string): Promise<string | string[]>;
      getDefault(): Promise<string>;
    };
    configs: {
      create(printer: string, options?: Record<string, unknown>): QzConfig;
    };
    security: {
      setCertificatePromise(fn: (resolve: (cert?: string) => void, reject: (e: unknown) => void) => void): void;
      setSignaturePromise(fn: (toSign: string) => (resolve: (sig?: string) => void, reject: (e: unknown) => void) => void): void;
    };
    print(config: QzConfig, data: Array<Record<string, unknown>>): Promise<void>;
  }
  const qz: Qz;
  export default qz;
}
