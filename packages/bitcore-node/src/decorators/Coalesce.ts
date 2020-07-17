import * as crypto from 'crypto';

const requestCache = {};
export function CoalesceClass<T extends new (...args: any[]) => {}>(aClass: T) {
  return class extends aClass {
    constructor(...args: any[]) {
      super(...args);
      for (let prop of Object.getOwnPropertyNames(aClass.prototype)) {
        if (typeof this[prop] === 'function') {
          this[prop] = CoalesceFunction(this[prop], this, prop);
        }
      }
    }
  };
}

export function CoalesceFunction(fn: (...args: any[]) => Promise<any>, bind?: any, name = fn.name) {
  let copy = fn;
  if (bind) {
    copy = copy.bind(bind);
  }

  return function(...args) {
    let requestKey = name + JSON.stringify(args);
    requestKey = crypto
      .createHash('sha256')
      .update(requestKey)
      .digest('hex');

    let cached = requestCache[requestKey];
    if (!cached) {
      requestCache[requestKey] = copy(...args);
      cached = requestCache[requestKey];
    }

    const asyncCleanup = (err, result) => {
      delete requestCache[requestKey];
      if (err) {
        return Promise.reject(err);
      }
      return Promise.resolve(result);
    };

    if (cached.then) {
      // handle async cached value
      return requestCache[requestKey].then(
        result => asyncCleanup(null, result),
        err => asyncCleanup(err, null)
      );
    }

    // handle sync functions
    delete requestCache[requestKey];
    return cached;
  };
}
