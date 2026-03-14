import type { ServerResponse } from "node:http";
import {
  type MockResponse,
  type RequestOptions,
  type Body as MockBody,
  createRequest,
  type MockRequest,
  type RequestMethod,
  type Headers as MockHeaders,
} from "node-mocks-http";
import { createResponse as createResponseMock } from "node-mocks-http";
import Connect from "connect";
import { Elysia } from "elysia";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction as ExpressNextFunction,
} from "express";

type ConnectServer = ReturnType<typeof Connect>;

function headersToRecord(headers: globalThis.Headers): MockHeaders {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record as MockHeaders;
}

export function connect(...middlewares: ConnectMiddleware[]) {
  const connectApp = Connect();

  for (const middleware of middlewares) {
    connectApp.use(middleware as unknown as Connect.HandleFunction);
  }

  return new Elysia({
    name: "connect",
    seed: middlewares,
  }).onRequest(async function processConnectMiddlewares({ request, set }) {
    const message = await transformRequestToIncomingMessage(
      connectApp,
      request as unknown as Request,
    );

    return await new Promise<Response | undefined>((resolve) => {
      const response = createResponse(message, resolve);

      connectApp.handle(message, response, () => {
        const webResponse = transformResponseToServerResponse(response);

        webResponse.headers.forEach((value, key) => {
          set.headers[key] = value;
        });
        set.status = webResponse.status;

        resolve(undefined);
      });
    });
  });
}

type ConnectMiddleware = (
  req: MockRequest<ExpressRequest>,
  res: MockResponse<ExpressResponse>,
  next: ExpressNextFunction,
) => unknown;

function mockAppAtRequest(
  message: MockRequest<ExpressRequest>,
  connectApp: ConnectServer,
) {
  const mock = message as unknown as {
    app: ConnectServer & { get(key: string): boolean };
  };
  mock.app = Object.assign(connectApp, {
    get: (_key: string) => false,
  });

  return message;
}

async function transformRequestToIncomingMessage(
  connectApp: ConnectServer,
  request: Request,
  options?: RequestOptions,
) {
  const parsedURL = new URL(request.url, "http://localhost");

  const query: Record<string, unknown> = {};

  for (const [key, value] of parsedURL.searchParams.entries()) {
    query[key] = value;
  }

  let body: MockBody | Body | undefined;

  try {
    body = (await request.clone().json()) as MockBody;
  } catch {
    body = undefined;
  }

  const message = createRequest({
    method: request.method.toUpperCase() as RequestMethod,
    url: parsedURL.pathname + parsedURL.search,
    path: parsedURL.pathname,
    originalUrl: parsedURL.pathname + parsedURL.search,
    baseUrl: parsedURL.origin,
    headers: headersToRecord(request.headers),
    query,
    body,
    ...options,
  });

  return mockAppAtRequest(message, connectApp);
}

function transformResponseToServerResponse(
  serverResponse: MockResponse<ServerResponse>,
) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(serverResponse.getHeaders())) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }

  return new Response(
    serverResponse._getData() || serverResponse._getBuffer(),
    {
      status: serverResponse.statusCode,
      statusText: serverResponse.statusMessage,
      headers,
    },
  );
}

type MockResponseExtended = MockResponse<ServerResponse> & {
  _implicitHeader?: () => void;
};

function createResponse(
  request: Express.Request,
  resolve: (value: Response) => void,
) {
  const response = createResponseMock({
    req: request,
  }) as MockResponseExtended;

  if (!response._implicitHeader) {
    response._implicitHeader = () => {};
  }

  const originalEnd = response.end;

  response.end = ((...args: Parameters<typeof originalEnd>) => {
    const call = originalEnd.call(response, ...args);
    const webResponse = transformResponseToServerResponse(response);
    resolve(webResponse);

    return call;
  }) as typeof originalEnd;

  return response;
}
