declare module '*.output/server/index.mjs' {
  const handler: import('@cloudflare/workers-types').ExportedHandler;
  export default handler;
}
