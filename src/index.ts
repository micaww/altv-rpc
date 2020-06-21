import alt from 'alt';
import * as util from './util';

const environment = util.getEnvironment();
if(!environment) throw 'Unknown alt:V environment';

const ERR_NOT_FOUND = 'PROCEDURE_NOT_FOUND';

const PROCESS_EVENT = '__rpc:process'; // main event for processing incoming procedure requests & responses
const BROWSER_REGISTER = '__rpc:browserRegister'; // event for when a browser registers a procedure
const TRIGGER_EVENT = '__rpc:triggerEvent'; // procedure for handling events
const TRIGGER_EVENT_BROWSERS = '__rpc:triggerEventBrowsers'; // procedure for sending event to all browsers

const rpcListeners: { [prop: string]: Function } = {}; // keeps track of procedure listeners
const rpcPending: { [prop: string]: any } = {}; // keeps track of called procedures that are waiting on results
const rpcEvListeners: { [prop: string]: Set<Function> } = {}; // keeps track of event listeners
const rpcBrowsers: any[] = []; // list of all registered webviews
const rpcBrowserProcedures: { [prop: string]: any } = {}; // which webviews are registered to which procedures

let rpcNamespace = '';

/**
 * Initializes RPC with a given namespace. Must be unique across all resources.
 *
 * @param namespace
 */
export function init(namespace: string) {
    if (rpcNamespace) throw 'Already initialized.';
    if (!namespace) throw 'Must specify a namespace.';
    if (!util.requestNamespace(namespace)) throw `Namespace "${namespace}" is already in use.`;

    util.log(`Initialized with namespace "${namespace}"`);

    rpcNamespace = namespace;

    const processEventName = getEventName(PROCESS_EVENT);
    const triggerEventName = getEventName(TRIGGER_EVENT);

    alt.on(processEventName, processEvent);

    if (environment === 'server') {
        alt.onClient(processEventName, (player: any, data: any) => processEvent(data, player));
    }

    if (environment === 'client') {
        alt.onServer(processEventName, processEvent);

        // set up internal pass-through events
        register('__rpc:callServer', ([name, args, noRet], info) => _callServer(name, args, { fenv: info.environment, noRet }));
        register('__rpc:callBrowsers', ([name, args, noRet], info) => _callBrowsers(null, name, args, { fenv: info.environment, noRet }));

        // send an event to all browsers
        register(getEventName(TRIGGER_EVENT_BROWSERS), ([name, args], info) => {
            rpcBrowsers.forEach(browser => {
                _callBrowser(browser, triggerEventName, [name, args], { fenv: info.environment, noRet: 1 });
            });
        });
    }

    // built-in procedure for calling events
    register(triggerEventName, ([name, args], info) => callEvent(name, args, info));
}

function getEventName(prefix: string) {
    return `${prefix}::${rpcNamespace}`;
}

function requireNamespace() {
    if (!rpcNamespace) throw new Error(`You must first call rpc.init() with a namespace.`);
}

/**
 * Processes an incoming event.
 *
 * @param rawData - the stringified event
 * @param player - whoever sent us the event, only on server environment
 * @param webView - the webview that sent us the event, only on client environment
 */
function processEvent(rawData: string, player?: any, webView?: any) {
    util.log(`Processing Event: ${rawData}${player ? ' from player' : ''}${webView ? ' from cef' : ''}`);

    const data: Event = util.parseData(rawData);

    const processEventName = getEventName(PROCESS_EVENT);

    if (data.req) { // someone is trying to remotely call a procedure
        const info: ProcedureListenerInfo = {
            id: data.id,
            environment: data.fenv || data.env,
            player
        };

        const part = {
            ret: 1,
            id: data.id,
            env: environment
        };

        let ret: (rawData: string) => void;

        switch(environment){
            case 'server':
                // send an event back to the sender
                ret = ev => alt.emitClient(player, processEventName, ev);
                break;
            case 'client': {
                if(data.env === 'server'){
                    // send an event back to the server
                    ret = ev => alt.emitServer(processEventName, ev);
                }else if(data.env === 'cef'){
                    info.browser = webView;

                    // send an event back to calling webview
                    ret = ev => webView && webView.valid && webView.emit(processEventName, ev);
                }
                break;
            }
            case 'cef': {
                // send an event back to the client
                ret = ev => alt.emit(PROCESS_EVENT, ev);
            }
        }

        if (ret) {
            const promise = callProcedure(data.name, data.args, info);
            if(!data.noRet) promise.then(res => ret(util.stringifyData({ ...part, res }))).catch(err => ret(util.stringifyData({ ...part, err: err !== null ? err : null })));
        }
    }else if (data.ret) { // a previously called remote procedure has returned
        const info = rpcPending[data.id];
        if(environment === 'server' && info.player !== player) return;
        if (info) {
            info.resolve(data.hasOwnProperty('err') ? Promise.reject(data.err) : data.res);
            delete rpcPending[data.id];
        }
    }
}

async function callProcedure(name: string, args: any, info: ProcedureListenerInfo): Promise<any> {
    const listener = rpcListeners[name];
    if (!listener) throw ERR_NOT_FOUND;
    return listener(args, info);
}

/**
 * Notifies RPC about a WebView.
 *
 * @param webView
 */
export function addWebView(webView: any) {
    requireNamespace();

    if (environment !== "client") throw 'addWebView can only be used on the client';

    if (!rpcBrowsers.includes(webView)) {
        webView.on(PROCESS_EVENT, (rawData: string) => processEvent(rawData, undefined, webView));

        webView.on(BROWSER_REGISTER, (procedure: string) => {
            rpcBrowserProcedures[procedure] = webView;
        });

        rpcBrowsers.push(webView);
    }
}

/**
 * Register a procedure.
 * @param {string} name - The name of the procedure.
 * @param {function} cb - The procedure's callback. The return value will be sent back to the caller.
 */
export function register(name: string, cb: ProcedureListener): void {
    if(arguments.length !== 2) throw 'register expects 2 arguments: "name" and "cb"';

    util.log(`Registered procedure "${name}"`);

    if (environment === 'cef') {
        // notify the client that we have ownership of this procedure
        alt.emit(BROWSER_REGISTER, name);
    }

    rpcListeners[name] = cb;
}

/**
 * Unregister a procedure.
 * @param {string} name - The name of the procedure.
 */
export function unregister(name: string): void {
    if(arguments.length !== 1) throw 'unregister expects 1 argument: "name"';
    rpcListeners[name] = undefined;
}

/**
 * Calls a local procedure. Only procedures registered in the same context will be resolved.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the locally registered procedure.
 * @param args - Any parameters for the procedure.
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function call(name: string, args?: any, options: CallOptions = {}): Promise<any> {
    if(arguments.length < 1 || arguments.length > 3) return Promise.reject('call expects 1 to 3 arguments: "name", optional "args", and optional "options"');
    return util.promiseTimeout(callProcedure(name, args, { environment }), options.timeout);
}

function _callServer(name: string, args?: any, extraData: any = {}): Promise<any> {
    requireNamespace();

    switch(environment){
        case 'server': {
            return call(name, args);
        }
        case 'client': {
            const id = util.uid();
            return new Promise(resolve => {
                if(!extraData.noRet){
                    rpcPending[id] = {
                        resolve
                    };
                }
                const event: Event = {
                    req: 1,
                    id,
                    name,
                    env: environment,
                    args,
                    ...extraData
                };
                alt.emitServer(getEventName(PROCESS_EVENT), util.stringifyData(event));
            });
        }
        case 'cef': {
            return callClient('__rpc:callServer', [name, args, +extraData.noRet]);
        }
    }
}

/**
 * Calls a remote procedure registered on the server.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callServer(name: string, args?: any, options: CallOptions = {}): Promise<any> {
    requireNamespace();

    if(arguments.length < 1 || arguments.length > 3) return Promise.reject('callServer expects 1 to 3 arguments: "name", optional "args", and optional "options"');

    let extraData: any = {};
    if(options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callServer(name, args, extraData), options.timeout);
}

function _callClient(player: any, name: string, args?: any, extraData: any = {}): Promise<any> {
    requireNamespace();

    switch(environment){
        case 'client': {
            return call(name, args);
        }
        case 'server': {
            const id = util.uid();

            return new Promise(resolve => {
                if(!extraData.noRet){
                    rpcPending[id] = {
                        resolve,
                        player
                    };
                }

                const event: Event = {
                    req: 1,
                    id,
                    name,
                    env: environment,
                    args,
                    ...extraData
                };

                alt.emitClient(player, getEventName(PROCESS_EVENT), util.stringifyData(event));
            });
        }
        case 'cef': {
            const id = util.uid();

            return new Promise(resolve => {
                if(!extraData.noRet){
                    rpcPending[id] = {
                        resolve
                    };
                }

                const event: Event = {
                    req: 1,
                    id,
                    name,
                    env: environment,
                    args,
                    ...extraData
                };

                alt.emit(PROCESS_EVENT, util.stringifyData(event));
            });
        }
    }
}

/**
 * Calls a remote procedure registered on the client.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callClient(player: any | string, name?: string | any, args?: any, options: CallOptions = {}): Promise<any> {
    requireNamespace();

    switch(environment){
        case 'client': {
            options = args || {};
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 3) || typeof name !== 'string') return Promise.reject('callClient from the client expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            break;
        }
        case 'server': {
            if((arguments.length < 2 || arguments.length > 4) || typeof player !== 'object') return Promise.reject('callClient from the server expects 2 to 4 arguments: "player", "name", optional "args", and optional "options"');
            break;
        }
        case 'cef': {
            options = args || {};
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 3) || typeof name !== 'string') return Promise.reject('callClient from the browser expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            break;
        }
    }

    let extraData: any = {};
    if(options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callClient(player, name, args, extraData), options.timeout);
}

function _callBrowser(browser: any, name: string, args?: any, extraData: any = {}): Promise<any> {
    if (!browser || !browser.valid) return Promise.reject('INVALID_BROWSER');
    requireNamespace();

    return new Promise(resolve => {
        const id = util.uid();

        if(!extraData.noRet){
            rpcPending[id] = {
                resolve
            };
        }

        const event: Event = {
            req: 1,
            id,
            name,
            env: environment,
            args,
            ...extraData
        };

        browser.emit(getEventName(PROCESS_EVENT), util.stringifyData(event));
    });
}

function _callBrowsers(player: any, name: string, args?: any, extraData: any = {}): Promise<any> {
    requireNamespace();

    switch(environment){
        case 'client':
            const browser = rpcBrowserProcedures[name];
            if(!browser || !browser.valid) return Promise.reject(ERR_NOT_FOUND);
            return _callBrowser(browser, name, args, extraData);
        case 'server':
            return _callClient(player, '__rpc:callBrowsers', [name, args, +extraData.noRet], extraData);
        case 'cef':
            return _callClient(null, '__rpc:callBrowsers', [name, args, +extraData.noRet], extraData);
    }
}

/**
 * Calls a remote procedure registered in any browser context.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callBrowsers(player: any | string, name?: string | any, args?: any, options: CallOptions = {}): Promise<any> {
    requireNamespace();

    let promise;
    let extraData: any = {};

    switch(environment){
        case 'client':
        case 'cef':
            options = args || {};
            args = name;
            name = player;
            if(arguments.length < 1 || arguments.length > 3) return Promise.reject('callBrowsers from the client or browser expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            if(options.noRet) extraData.noRet = 1;
            promise = _callBrowsers(null, name, args, extraData);
            break;
        case 'server':
            if(arguments.length < 2 || arguments.length > 4) return Promise.reject('callBrowsers from the server expects 2 to 4 arguments: "player", "name", optional "args", and optional "options"');
            if(options.noRet) extraData.noRet = 1;
            promise = _callBrowsers(player, name, args, extraData);
            break;
    }

    if(promise){
        return util.promiseTimeout(promise, options.timeout);
    }
}

/**
 * Calls a remote procedure registered in a specific browser instance.
 *
 * Client-side environment only.
 *
 * @param browser - The browser instance.
 * @param name - The name of the registered procedure.
 * @param args - Any parameters for the procedure.
 * @param options - Any options.
 * @returns The result from the procedure.
 */
export function callBrowser(browser: any, name: string, args?: any, options: CallOptions = {}): Promise<any> {
    if(environment !== 'client') return Promise.reject('callBrowser can only be used in the client environment');
    if(arguments.length < 2 || arguments.length > 4) return Promise.reject('callBrowser expects 2 to 4 arguments: "browser", "name", optional "args", and optional "options"');
    requireNamespace();

    let extraData: any = {};
    if(options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callBrowser(browser, name, args, extraData), options.timeout);
}

function callEvent(name: string, args: any, info: ProcedureListenerInfo){
    const listeners = rpcEvListeners[name];
    if(listeners){
        listeners.forEach((listener: Function) => listener(args, info));
    }
}

/**
 * Register an event handler.
 * @param {string} name - The name of the event.
 * @param cb - The callback for the event.
 */
export function on(name: string, cb: ProcedureListener){
    if(arguments.length !== 2) throw 'on expects 2 arguments: "name" and "cb"';

    const listeners = rpcEvListeners[name] || new Set();
    listeners.add(cb);
    rpcEvListeners[name] = listeners;
}

/**
 * Unregister an event handler.
 * @param {string} name - The name of the event.
 * @param cb - The callback for the event.
 */
export function off(name: string, cb: ProcedureListener){
    if(arguments.length !== 2) throw 'off expects 2 arguments: "name" and "cb"';

    const listeners = rpcEvListeners[name];
    if(listeners){
        listeners.delete(cb);
    }
}

/**
 * Triggers a local event. Only events registered in the same context will be triggered.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the locally registered event.
 * @param args - Any parameters for the event.
 */
export function trigger(name: string, args?: any){
    if(arguments.length < 1 || arguments.length > 2) throw 'trigger expects 1 or 2 arguments: "name", and optional "args"';
    callEvent(name, args, { environment });
}

/**
 * Triggers an event registered on the client.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerClient(player: any | string, name?: string | any, args?: any){
    requireNamespace();

    switch(environment){
        case 'client': {
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 2) || typeof name !== 'string') throw 'triggerClient from the client expects 1 or 2 arguments: "name", and optional "args"';
            break;
        }
        case 'server': {
            if((arguments.length < 2 || arguments.length > 3) || typeof player !== 'object') throw 'triggerClient from the server expects 2 or 3 arguments: "player", "name", and optional "args"';
            break;
        }
        case 'cef': {
            args = name;
            name = player;
            player = null;
            if((arguments.length < 1 || arguments.length > 2) || typeof name !== 'string') throw 'triggerClient from the browser expects 1 or 2 arguments: "name", and optional "args"';
            break;
        }
    }

    _callClient(player, getEventName(TRIGGER_EVENT), [name, args], { noRet: 1 });
}

/**
 * Triggers an event registered on the server.
 *
 * Can be called from any environment.
 *
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerServer(name: string, args?: any){
    if(arguments.length < 1 || arguments.length > 2) throw 'triggerServer expects 1 or 2 arguments: "name", and optional "args"';
    requireNamespace();

    _callServer(getEventName(TRIGGER_EVENT), [name, args], { noRet: 1 });
}

/**
 * Triggers an event registered in any browser context.
 *
 * Can be called from any environment.
 *
 * @param player - The player to call the procedure on.
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerBrowsers(player: any | string, name?: string | any, args?: any){
    switch(environment){
        case 'client':
        case 'cef':
            args = name;
            name = player;
            player = null;
            if(arguments.length < 1 || arguments.length > 2) throw 'triggerBrowsers from the client or browser expects 1 or 2 arguments: "name", and optional "args"';
            break;
        case 'server':
            if(arguments.length < 2 || arguments.length > 3) throw 'triggerBrowsers from the server expects 2 or 3 arguments: "player", "name", and optional "args"';
            break;
    }

    requireNamespace();

    _callClient(player, getEventName(TRIGGER_EVENT_BROWSERS), [name, args], { noRet: 1 });
}

/**
 * Triggers an event registered in a specific browser instance.
 *
 * Client-side environment only.
 *
 * @param browser - The browser instance.
 * @param name - The name of the event.
 * @param args - Any parameters for the event.
 */
export function triggerBrowser(browser: any, name: string, args?: any){
    if(environment !== 'client') throw 'callBrowser can only be used in the client environment';
    if(arguments.length < 2 || arguments.length > 4) throw 'callBrowser expects 2 or 3 arguments: "browser", "name", and optional "args"';
    requireNamespace();

    _callBrowser(browser, getEventName(TRIGGER_EVENT), [name, args], { noRet: 1});
}

export default {
    init,
    addWebView,
    register,
    unregister,
    call,
    callServer,
    callClient,
    callBrowsers,
    callBrowser,
    on,
    off,
    trigger,
    triggerServer,
    triggerClient,
    triggerBrowsers,
    triggerBrowser
};