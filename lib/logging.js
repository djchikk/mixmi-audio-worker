// What the worker's log may hold (Astra's P2-3 on worker #4, 2026-11-01): the
// same promise as its replies (./errors), for everything Fastify and pino log
// too. Fastify's own lines carry a request's URL (query and all), an error's
// message (a JSON parse error quotes the body) and, in places, the error itself
// as the message. So:
//
//   serializers  req → method and route (a known route, or `unmatched`), never
//                the URL; res → the status code; err → its listed code or null,
//                never a message or a stack.
//   logMethod    every line's message must be one of MESSAGES (or Fastify's
//                "Server listening at <address>"); any other is withheld. An
//                Error logged as the first argument goes through the err
//                serializer instead of becoming the message.

const { CODES } = require('./errors');

const ROUTES = new Set(['/', '/health', '/enhance', '/transcode-video', '/strip-metadata']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// the worker's own messages (index.js) and Fastify's request lines
const MESSAGES = new Set([
  'incoming request', 'request completed', 'request errored',
  'Downloaded', 'Written back in place', 'Job failed', 'Request refused', 'Request failed', 'Route not found',
]);
const LISTENING = /^Server listening at https?:\/\/[\w.:[\]-]+$/;
const WITHHELD = 'message withheld';

/** A request's route as it may be logged: one of the worker's own, or `unmatched`. */
const routeOf = (url) => {
  const p = String(url ?? '').split('?')[0];
  return ROUTES.has(p) ? p : 'unmatched';
};

const serializers = {
  req: (req) => ({ method: METHODS.has(req?.method) ? req.method : 'other', route: routeOf(req?.url) }),
  res: (res) => ({ statusCode: Number.isInteger(res?.statusCode) ? res.statusCode : null }),
  err: (e) => ({ code: e && Object.prototype.hasOwnProperty.call(CODES, e.workerCode) ? e.workerCode : null }),
};

function logMethod(args, method) {
  const [first, second] = args;
  const obj = first instanceof Error ? { err: first } : first && typeof first === 'object' ? first : {};
  const msg = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
  return method.call(this, obj, MESSAGES.has(msg) || LISTENING.test(msg) ? msg : WITHHELD);
}

/** The worker's Fastify logger options. */
const loggerOptions = () => ({ level: process.env.LOG_LEVEL || 'info', serializers, hooks: { logMethod } });

module.exports = { loggerOptions, routeOf, MESSAGES, WITHHELD };
