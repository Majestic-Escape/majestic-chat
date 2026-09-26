import { gzipSync } from 'zlib';
import type { NextFunction, Request, Response } from 'express';

/**
 * gzip for the JSON the chat REST routes send (conversation lists with message
 * previews, history pages). Most users are on phones far from this server; a
 * 30–60 KB list needs extra round trips of TCP slow start that a 6–10 KB
 * compressed body does not. Bodies under MIN_BYTES go out as they are (the
 * header and CPU would cost more than they save). Socket.IO traffic does not
 * pass through Express and is unaffected (it has its own per-message deflate).
 *
 * Built on zlib rather than the `compression` package: it only needs to cover
 * res.json on one router, and adds no dependency.
 */
const MIN_BYTES = 1024;

export function gzipJson(req: Request, res: Response, next: NextFunction): void {
  res.vary('Accept-Encoding');
  if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    const text = JSON.stringify(body);
    if (text === undefined || Buffer.byteLength(text) < MIN_BYTES) return json(body);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    return res.send(gzipSync(text, { level: 6 }));
  };
  next();
}
