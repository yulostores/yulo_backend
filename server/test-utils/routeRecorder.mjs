// Lists the routes an Express app actually mounts. Express 5 (router@2) keeps no mount path on its
// layers, so the recorder wraps Router#use / Router#route while the app is being built and keeps
// what they were called with. Call installRouteRecorder() BEFORE importing app.js, then
// uninstall() once it is imported, and mountedRoutes(app, scope) to read the list.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const installRouteRecorder = () => {
  const Router = require('router');
  const originalUse = Router.prototype.use;
  const originalRoute = Router.prototype.route;
  Router.prototype.use = function recordUse(...args) {
    (this.__mounts ??= []).push({ path: typeof args[0] === 'string' ? args[0] : '/', fns: args.flat().filter((f) => typeof f === 'function') });
    return originalUse.apply(this, args);
  };
  Router.prototype.route = function recordRoute(path) {
    const route = originalRoute.call(this, path);
    (this.__routes ??= []).push({ path, route });
    return route;
  };
  return {
    uninstall() {
      Router.prototype.use = originalUse;
      Router.prototype.route = originalRoute;
    },
  };
};

const join = (a, b) => `${a}/${b}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

/** "METHOD /full/path" for every route mounted under `app` whose path matches `scope`. */
export const mountedRoutes = (app, scope = /./) => {
  const out = [];
  const walk = (router, prefix) => {
    for (const { path, route } of router.__routes ?? []) {
      for (const method of Object.keys(route.methods)) if (method !== '_all') out.push(`${method.toUpperCase()} ${join(prefix, path)}`);
    }
    for (const { path, fns } of router.__mounts ?? []) for (const fn of fns) if (fn.__mounts || fn.__routes) walk(fn, join(prefix, path));
  };
  walk(app.router, '/');
  return out.filter((r) => scope.test(r.split(' ')[1]));
};

/** The coupon system's routes (CB1–CB10). */
export const COUPON_ROUTE_SCOPE = /^\/api\/(seller(\/|$)|admin\/coupon|admin\/sellers(\/|$)|admin\/reminder-campaigns(\/|$)|users\/me\/coupons(\/|$))/;
