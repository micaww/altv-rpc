import alt from 'alt';

const glob = getGlobal();
const setTimeout = alt.setTimeout || glob.setTimeout;

/**
 * Generates a random ID.
 */
export function uid(): string {
    const first = (Math.random() * 46656) | 0;
    const second = (Math.random() * 46656) | 0;
    const firstPart = ('000' + first.toString(36)).slice(-3);
    const secondPart = ('000' + second.toString(36)).slice(-3);
    return firstPart + secondPart;
}

/**
 * Gets the current execution environment.
 */
export function getEnvironment(): string {
    if (!alt.Player) return 'cef';
    else if (alt.Player.local) return 'client';
    else if (alt.Player) return 'server';
}

/**
 * Stringifies an event's data for transmission.
 */
export function stringifyData(data: any): string {
    const env = getEnvironment();

    return JSON.stringify(data, (_, value) => {
        if ((env === 'client' || env === 'server') && value instanceof alt.Entity) {
            return {
                __i: value.id
            };
        }

        return value;
    });
}

/**
 * Turns stringified event data back into a JS object.
 */
export function parseData(data: string): any {
    const env = getEnvironment();

    try {
        return JSON.parse(data, (_, value) => {
            if ((env === 'client' || env === 'server') && value && typeof value === 'object' && typeof value.__i === 'number' && Object.keys(value).length === 1) {
                return alt.Entity.getByID(value.__i);
            }

            return value;
        });
    } catch (e) {
        log(`Failed to parse event arguments: ${e.message}`, true);
        log(data, true);
    }
}

/**
 * Waits for a promise to be settled or a timeout, whichever comes first.
 */
export function promiseTimeout(promise: Promise<any>, timeout?: number){
    if (typeof timeout === 'number') {
        return Promise.race([
            new Promise((_, reject) => {
                setTimeout(() => reject('TIMEOUT'), timeout);
            }),
            promise
        ]);
    } else return promise;
}

/**
 * Gets the global object, if any.
 */
function getGlobal(): any {
    if (typeof global !== 'undefined') return global;
    else if (typeof window !== 'undefined') return window;
}

/**
 * Requests a namespace. Returns false if it's already in use.
 */
export function requestNamespace(ns: string) {
    const key = '__rpc:namespaces';

    const addIfAbsent = (list: string[], ns: string) => {
        if (!list.includes(ns)) {
            list.push(ns);
            return true;
        }
    };

    if (glob) {
        const list = glob[key] || [];

        if (!addIfAbsent(list, ns)) return false;

        glob[key] = list;
    } else {
        const ply = alt.Player.local;

        if (ply) {
            const raw = ply.getMeta(key);
            const list = raw ? JSON.parse(raw) : [];

            if (!addIfAbsent(list, ns)) return false;

            ply.setMeta(key, JSON.stringify(list));
        }
    }

    return true;
}

export function log(data: string, always = false) {
    const env = getEnvironment();

    if (always || process.env.NODE_ENV !== 'production') {
        (alt.log || console.log)(`RPC (${env}): ${data}`);
    }
}

/**
 * Splits a string into an array of chunks.
 */
export function chunk(data: string) {
    return data.match(/.{1,10000}/g);
}
