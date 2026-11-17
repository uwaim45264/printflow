// Editor-only: the parts of the Deno runtime the Edge Functions use (the real types come from Deno itself).
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
