import alt from 'alt';
import * as util from './util';

const environment = util.getEnvironment();
if (!environment) throw 'Unknown alt:V environment';

const ERR_NOT_FOUND = 'PROCEDURE_NOT_FOUND';

const PROCESS_EVENT = '__rpc:process'; // main event for processing incoming procedure requests & responses
const BROWSER_REGISTER = '__rpc:browserRegister'; // event for when a browser registers a procedure
const TRIGGER_EVENT = '__rpc:triggerEvent'; // procedure for handling events
const TRIGGER_EVENT_BROWSERS = '__rpc:triggerEventBrowsers'; // procedure for sending event to all browsers

enum EventType {
    REQUEST,
    RESPONSE_SUCCESS,
    RESPONSE_ERROR
}

/**
 * Represents any packet used by RPC.
 */
interface Event {
    /** The unique ID of this transmission. */
    id: string;

    /** The type of this event. */
    type: EventType;

    /** The name of the procedure we are going to be calling. */
    name?: string;

    /** The real environment that sent this packet. */
    env: string;

    /** The partial number of the original event. */
    part: number;

    /** The total number of event partials. */
    total: number;

    /** Stringified args partial. */
    args?: string;

    /** If set, we shouldn't return anything. */
    noRet?: 1;

    /** Environment override. Used for cef <-> server. */
    fenv?: string;
}

/**
 * Represents a request that is pending a response.
 */
interface Pending {
    /** The player that we're expecting a response from. */
    player?: any;

    /** The resolve function for the promise. */
    resolve: Function;
}

/**
 * Represents an ongoing incoming RPC call.
 */
interface Incoming {
    /** The stringified arguments that we have received so far. */
    args?: string;

    /** The number of parts we've received. */
    recv: number;

    /** The total number of parts we're expecting. */
    total: number;
}

const rpcListeners: { [prop: string]: Function } = {}; // keeps track of procedure listeners
const rpcPending: { [prop: string]: Pending } = {}; // keeps track of called procedures that are waiting on results
const rpcIncoming: { [prop: string]: Incoming } = {}; // keeps track of incoming packets that might have multiple parts
const rpcEvListeners: { [prop: string]: Set<Function> } = {}; // keeps track of event listeners
const rpcBrowsers: any[] = []; // list of all registered webviews
const rpcBrowserProcedures: { [prop: string]: any } = {}; // which webviews are registered to which procedures

let rpcNamespace = '';

/**
 * Initializes RPC with a given namespace. Must be unique across all resources.
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
 * @param event - the event
 * @param player - whoever sent us the event, only on server environment
 * @param webView - the webview that sent us the event, only on client environment
 */
function processEvent(event: Event, player?: any, webView?: any) {
    util.log(`Processing Event: ${event.id} (${event.part}/${event.total})${player ? ' from player' : ''}${webView ? ' from cef' : ''}`);

    // keep track of incoming partials
    const incoming = rpcIncoming[event.id] || {
        recv: 0,
        total: event.total
    };

    if (typeof event.args !== 'undefined') {
        // add any args to our builder
        if (!incoming.args) incoming.args = '';
        incoming.args += event.args;
    }
    incoming.recv++;

    rpcIncoming[event.id] = incoming;

    // only process the event if we've received it all
    if (incoming.recv < incoming.total) return;

    util.log(`Stringified Args: ${incoming.args}`);

    const args = typeof incoming.args !== 'undefined' ? util.parseData(incoming.args) : undefined;

    const processEventName = getEventName(PROCESS_EVENT);

    if (event.type === EventType.REQUEST) {
        const info: ProcedureListenerInfo = {
            id: event.id,
            environment: event.fenv || event.env,
            player
        };

        let ret: (event: Event) => void;
        let split = true;

        switch(environment) {
            case 'server':
                // send an event back to the sender
                ret = ev => alt.emitClient(player, processEventName, ev);
                break;
            case 'client': {
                if (event.env === 'server') {
                    // send an event back to the server
                    ret = ev => alt.emitServer(processEventName, ev);
                } else if (event.env === 'cef') {
                    info.browser = webView;

                    // send an event back to calling webview
                    ret = ev => webView && webView.valid && webView.emit(processEventName, ev);
                }
                break;
            }
            case 'cef': {
                // send an event back to the client
                ret = ev => alt.emit(PROCESS_EVENT, ev);
                split = false;
            }
        }

        if (ret) {
            const promise = callProcedure(event.name, args, info);

            if (!event.noRet) {
                let type = EventType.RESPONSE_SUCCESS;
                let args: any;

                promise.then(res => {
                    args = res;
                }).catch(err => {
                    type = EventType.RESPONSE_ERROR;
                    args = err;
                }).finally(() => {
                    sendEvent({
                        type,
                        id: event.id,
                        env: environment
                    }, args, ret, split);
                });
            }
        }
    } else { // a previously called remote procedure has returned
        const info = rpcPending[event.id];

        // make sure we are receiving the answer from the right player
        if (environment === 'server' && info.player !== player) return;

        if (info) {
            info.resolve(event.type === EventType.RESPONSE_SUCCESS ? args : Promise.reject(args));
            delete rpcPending[event.id];
        }
    }
}

async function callProcedure(name: string, args: any, info: ProcedureListenerInfo): Promise<any> {
    const listener = rpcListeners[name];
    if (!listener) throw ERR_NOT_FOUND;
    return listener(args, info);
}

/**
 * Invokes the callback with each event partial after stringifying and splitting the arguments.
 */
function sendEvent(event: Omit<Event, 'args' | 'part' | 'total'>, args: any, callback: (event: Event) => void, split = true) {
    const send = (part: number, total: number, args?: string) => callback({
        ...event,
        part,
        total,
        args
    });

    if (typeof args !== 'undefined') {
        // we got args to send
        const stringified = util.stringifyData(args);
        const parts = split ? util.chunk(stringified) : [stringified];

        parts.forEach((part, idx) => {
            send(idx + 1, parts.length, part);
        });
    } else {
        // sending no args
        send(1, 1);
    }
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
        webView.on(PROCESS_EVENT, (event: Event) => processEvent(event, undefined, webView));

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

function _callServer(name: string, args?: any, extraData: Partial<Event> = {}): Promise<any> {
    requireNamespace();

    switch(environment){
        case 'server': {
            return call(name, args);
        }
        case 'client': {
            const id = util.uid();
            return new Promise(resolve => {
                if (!extraData.noRet) {
                    rpcPending[id] = {
                        resolve
                    };
                }

                sendEvent({
                    type: EventType.REQUEST,
                    id,
                    name,
                    env: environment,
                    ...extraData
                }, args, ev => alt.emitServer(getEventName(PROCESS_EVENT), ev));
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

    if (arguments.length < 1 || arguments.length > 3) return Promise.reject('callServer expects 1 to 3 arguments: "name", optional "args", and optional "options"');

    let extraData: Partial<Event> = {};
    if (options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callServer(name, args, extraData), options.timeout);
}

function _callClient(player: any, name: string, args?: any, extraData: Partial<Event> = {}): Promise<any> {
    requireNamespace();

    switch (environment) {
        case 'client': {
            return call(name, args);
        }
        case 'server': {
            const id = util.uid();

            return new Promise(resolve => {
                if (!extraData.noRet) {
                    rpcPending[id] = {
                        resolve,
                        player
                    };
                }

                sendEvent({
                    type: EventType.REQUEST,
                    id,
                    name,
                    env: environment,
                    ...extraData
                }, args, ev => alt.emitClient(player, getEventName(PROCESS_EVENT), ev));
            });
        }
        case 'cef': {
            const id = util.uid();

            return new Promise(resolve => {
                if (!extraData.noRet) {
                    rpcPending[id] = {
                        resolve
                    };
                }

                sendEvent({
                    type: EventType.REQUEST,
                    id,
                    name,
                    env: environment,
                    ...extraData
                }, args, ev => alt.emit(PROCESS_EVENT, ev), false);
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
            if ((arguments.length < 1 || arguments.length > 3) || typeof name !== 'string') return Promise.reject('callClient from the client expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            break;
        }
        case 'server': {
            if ((arguments.length < 2 || arguments.length > 4) || typeof player !== 'object') return Promise.reject('callClient from the server expects 2 to 4 arguments: "player", "name", optional "args", and optional "options"');
            break;
        }
        case 'cef': {
            options = args || {};
            args = name;
            name = player;
            player = null;
            if ((arguments.length < 1 || arguments.length > 3) || typeof name !== 'string') return Promise.reject('callClient from the browser expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            break;
        }
    }

    let extraData: Partial<Event> = {};
    if (options.noRet) extraData.noRet = 1;

    return util.promiseTimeout(_callClient(player, name, args, extraData), options.timeout);
}

function _callBrowser(browser: any, name: string, args?: any, extraData: Partial<Event> = {}): Promise<any> {
    if (!browser || !browser.valid) return Promise.reject('INVALID_BROWSER');
    requireNamespace();

    return new Promise(resolve => {
        const id = util.uid();

        if (!extraData.noRet) {
            rpcPending[id] = {
                resolve
            };
        }

        sendEvent({
            type: EventType.REQUEST,
            id,
            name,
            env: environment,
            ...extraData
        }, args, ev => browser.emit(getEventName(PROCESS_EVENT), ev), false);
    });
}

function _callBrowsers(player: any, name: string, args?: any, extraData: Partial<Event> = {}): Promise<any> {
    requireNamespace();

    switch (environment) {
        case 'client':
            const browser = rpcBrowserProcedures[name];
            if (!browser || !browser.valid) return Promise.reject(ERR_NOT_FOUND);
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
    let extraData: Partial<Event> = {};

    switch (environment) {
        case 'client':
        case 'cef':
            options = args || {};
            args = name;
            name = player;
            if (arguments.length < 1 || arguments.length > 3) return Promise.reject('callBrowsers from the client or browser expects 1 to 3 arguments: "name", optional "args", and optional "options"');
            if (options.noRet) extraData.noRet = 1;
            promise = _callBrowsers(null, name, args, extraData);
            break;
        case 'server':
            if (arguments.length < 2 || arguments.length > 4) return Promise.reject('callBrowsers from the server expects 2 to 4 arguments: "player", "name", optional "args", and optional "options"');
            if (options.noRet) extraData.noRet = 1;
            promise = _callBrowsers(player, name, args, extraData);
            break;
    }

    if (promise) {
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