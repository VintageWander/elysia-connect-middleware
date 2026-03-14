import type { ServerResponse } from "node:http";
import {
  type MockResponse,
  type RequestOptions,
  type Body as MockBody,
  createRequest,
  type MockRequest,
} from "node-mocks-http";
import { createResponse as createResponseMock } from "node-mocks-http";
import Connect from "connect";
import { Elysia } from "elysia";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction as ExpressNextFunction,
} from "express";

export function connect(...middlewares: ConnectMiddleware[]) {
  const connectApp = Connect();

  for (const middleware of middlewares) {
    // @ts-expect-error
    connectApp.use(middleware);
  }

  return new Elysia({
    name: "connect",
    seed: middlewares,
  }).onRequest(async function processConnectMiddlewares({ request, set }) {
    const message = await transformRequestToIncomingMessage(
      connectApp,
      request as unknown as Request
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
  next: ExpressNextFunction
) => unknown;

function mockAppAtRequest(message: MockRequest<any>, connectApp: any) {
  message.app = connectApp;

  message.app.get = (data: string) => {
    return false;
  };

  return message;
}

async function transformRequestToIncomingMessage(
  connectApp: any,
  request: Request,
  options?: RequestOptions
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
    method: request.method.toUpperCase() as "GET",
    url: parsedURL.pathname + parsedURL.search,
    path: parsedURL.pathname,
    originalUrl: parsedURL.pathname + parsedURL.search,
    baseUrl: parsedURL.origin,
    headers: JSON.parse(JSON.stringify(request.headers)),
    query,
    body,
    ...options,
  });

  return mockAppAtRequest(message, connectApp);
}

function transformResponseToServerResponse(
  serverResponse: MockResponse<ServerResponse>
) {
  // console.log("content", serverResponse._getData(), serverResponse._getBuffer());

  return new Response(
    serverResponse._getData() || serverResponse._getBuffer(),
    {
      status: serverResponse.statusCode,
      statusText: serverResponse.statusMessage,
      // @ts-expect-error
      headers: serverResponse.getHeaders(),
    }
  );
}

function createResponse(
  request: Express.Request,
  resolve: (value: Response) => void
) {
  const response = createResponseMock({
    req: request,
  });

  // @ts-expect-error
  if (!response._implicitHeader)
    // @ts-expect-error
    response._implicitHeader = () => {};

  const end = response.end;

  // @ts-expect-error
  response.end = (...args: Parameters<typeof response.end>) => {
    const call = end.call(response, ...args);
    const webResponse = transformResponseToServerResponse(response);
    resolve(webResponse);

    return call;
  };

  return response;
}
