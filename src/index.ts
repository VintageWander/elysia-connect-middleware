import type { IncomingMessage } from "node:http";
import { ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { Elysia } from "elysia";

export type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

const STATUS_CODES_WITHOUT_BODY = new Set([100, 101, 102, 103, 204, 205, 304]);

/**
 * Elysia plugin that runs Connect-style middleware (e.g. `vite.middlewares`)
 * in the `onRequest` hook. Streams responses instead of buffering.
 *
 * Returns `undefined` when middleware calls `next()` without handling the
 * request, so Elysia continues to its own routes.
 */
export function connect(...middlewares: ConnectMiddleware[]) {
  return new Elysia({
    name: "connect",
    seed: middlewares,
  }).onRequest(async ({ request, set }) => {
    const req = createIncomingMessage(request);
    const { res, onReadable } = createStreamingResponse(req);

    return new Promise<Response | undefined>((resolve, reject) => {
      (async () => {
        try {
          const { readable, headers, statusCode } = await onReadable;

          const responseHeaders = flattenHeaders(headers);
          responseHeaders.forEach((value, key) => {
            set.headers[key] = value;
          });
          set.status = statusCode;

          const body = STATUS_CODES_WITHOUT_BODY.has(statusCode)
            ? null
            : (Readable.toWeb(readable) as unknown as ReadableStream);

          resolve(
            new Response(body, {
              status: statusCode,
              headers: responseHeaders,
            }),
          );
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Error creating response"));
        }
      })();

      const next = (err?: unknown) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve(undefined);
        }
      };

      try {
        runMiddleware(middlewares, req, res, next);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }

      request.signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
    });
  });
}

/**
 * Walks a Connect middleware stack. Error handlers (arity >= 4) only run
 * when an error is present; normal handlers are skipped in that case.
 */
function runMiddleware(
  stack: ConnectMiddleware[],
  req: IncomingMessage,
  res: ServerResponse,
  done: (err?: unknown) => void,
) {
  let index = 0;

  function next(err?: unknown) {
    const handle = stack[index++] as ((...args: unknown[]) => void) | undefined;
    if (!handle) {
      done(err);
      return;
    }

    try {
      if (err) {
        if (handle.length >= 4) handle(err, req, res, next);
        else next(err);
      } else {
        if (handle.length < 4) handle(req, res, next);
        else next();
      }
    } catch (e) {
      next(e);
    }
  }

  next();
}

/**
 * Convert a web `Request` into a Node.js `IncomingMessage`-like `Readable`.
 * Body is streamed lazily — Vite middleware rarely reads it.
 */
function createIncomingMessage(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const pathnameAndQuery = (url.pathname || "") + (url.search || "");

  const cloned = request.clone();
  const body = cloned.body
    ? Readable.fromWeb(cloned.body as unknown as import("node:stream/web").ReadableStream)
    : Readable.from([]);

  return Object.assign(body, {
    url: pathnameAndQuery,
    originalUrl: pathnameAndQuery,
    method: request.method,
    headers: Object.fromEntries(request.headers),
  }) as unknown as IncomingMessage;
}

/**
 * Creates a real `ServerResponse` wired to a `PassThrough` stream.
 * The returned `onReadable` promise resolves once the middleware starts
 * writing, giving you a `Readable` you can pipe through `Readable.toWeb()`.
 */
function createStreamingResponse(incomingMessage: IncomingMessage) {
  const res = new ServerResponse(incomingMessage);
  const passThrough = new PassThrough();

  const onReadable = new Promise<{
    readable: Readable;
    headers: ReturnType<ServerResponse["getHeaders"]>;
    statusCode: number;
  }>((resolve, reject) => {
    passThrough.once("readable", () => {
      resolve({
        readable: Readable.from(passThrough),
        headers: res.getHeaders(),
        statusCode: res.statusCode,
      });
    });
    passThrough.once("error", reject);
  });

  res.once("finish", () => passThrough.end());
  passThrough.on("drain", () => res.emit("drain"));

  // Redirect writes through the PassThrough stream
  res.write = passThrough.write.bind(passThrough) as unknown as typeof res.write;
  res.end = passThrough.end.bind(passThrough) as unknown as typeof res.end;

  let headersSet = false;
  const originalWriteHead = res.writeHead;
  res.writeHead = function writeHead(
    statusCode: number,
    statusMessage?: string | Record<string, string | number | readonly string[] | undefined>,
    headers?: Record<string, string | number | readonly string[] | undefined>,
  ) {
    if (headersSet) return res;
    headersSet = true;
    res.statusCode = statusCode;

    if (typeof statusMessage === "object") {
      headers = statusMessage;
      statusMessage = undefined;
    }

    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
    }

    return res;
  } as typeof originalWriteHead;

  return { res, onReadable };
}

/**
 * Flatten `OutgoingHttpHeaders` into a `Headers` object.
 * Handles arrays (e.g. `set-cookie`) by appending.
 */
function flattenHeaders(
  raw: Record<string, string | number | readonly string[] | undefined>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}
